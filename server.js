import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }
});

app.use(cors());
app.use(express.json());

let cards = [];
let lockerState = {
  isOpen: false,
  isAlarm: false,
  forgottenObjects: false,
  servoAngle: 0,
  lastCardScanned: null
};

let isEsp32Connected = false;
let lastEsp32Ping = null;
let currentVoltage = 0.0; // Estado real de voltaje
let auditLogs = [];

const addLog = (type, message, cardId = null, user = 'Sistema') => {
  const log = {
    id: Date.now(),
    type,
    message,
    cardId,
    user,
    timestamp: new Date().toLocaleTimeString()
  };
  auditLogs.unshift(log);
  if (auditLogs.length > 50) auditLogs.pop();
  io.emit('new_log', log);
  return log;
};

// Monitor de presencia y pérdida de energía del ESP32
setInterval(() => {
  if (lastEsp32Ping && (Date.now() - lastEsp32Ping > 8000)) {
    if (isEsp32Connected) {
      isEsp32Connected = false;
      currentVoltage = 0.0; // Al desconectarse vuelve a 0V
      addLog('WARNING', 'ESP32 fuera de línea / Alimentación cortada');
      io.emit('hardware_status', { connected: false, voltage: 0.0 });
    }
  }
}, 3000);

// --- RUTAS API REST ---
app.get('/api/cards', (req, res) => res.json(cards));

app.post('/api/cards', (req, res) => {
  const { id, owner } = req.body;
  if (!id || !owner) return res.status(400).json({ error: 'Faltan datos requeridos' });

  const existingCard = cards.find(c => c.id === id);
  if (existingCard) {
    existingCard.owner = owner;
  } else {
    cards.push({ id, owner, isPaid: true, active: true });
  }

  addLog('INFO', `Socio/Tarjeta registrado(a): ${owner} (${id})`, id, owner);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

app.put('/api/cards/:id', (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  cards = cards.map(c => c.id === id ? { ...c, active } : c);
  addLog('INFO', `Estado de tarjeta ${id} cambiado a ${active ? 'ACTIVA' : 'DESACTIVADA'}`);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

app.put('/api/cards/:id/membership', (req, res) => {
  const { id } = req.params;
  const { isPaid } = req.body;
  cards = cards.map(c => c.id === id ? { ...c, isPaid } : c);
  addLog('INFO', `Membresía de tarjeta ${id} actualizada a ${isPaid ? 'PAGADA' : 'IMPAGA'}`);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

app.delete('/api/cards/:id', (req, res) => {
  const { id } = req.params;
  cards = cards.filter(c => c.id !== id);
  addLog('INFO', `Tarjeta eliminada del sistema: ${id}`);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

app.get('/api/logs', (req, res) => res.json(auditLogs));

app.post('/api/locker/reset-alarm', (req, res) => {
  lockerState.isAlarm = false;
  addLog('INFO', 'Alarma desactivada remotamente desde la web');
  io.emit('update_locker', lockerState);
  res.json({ success: true });
});

// --- ENDPOINT WEBHOOK RECEPTOR DEL ESP32 ---
app.post('/api/webhook', (req, res) => {
  const { event, cardId, forced, objectDetected, voltage } = req.body;

  lastEsp32Ping = Date.now();

  // Actualizar lectura de voltaje en tiempo real si viene en el payload
  if (voltage !== undefined && voltage !== null) {
    currentVoltage = parseFloat(voltage);
  } else if (!isEsp32Connected) {
    currentVoltage = 5.0; // Valor nominal de respaldo si está recién conectado
  }

  if (!isEsp32Connected) {
    isEsp32Connected = true;
    addLog('INFO', `Hardware ESP32 enlazado (${currentVoltage.toFixed(1)}V)`);
  }

  // Transmitir telemetría en tiempo real
  io.emit('hardware_status', { connected: true, voltage: currentVoltage });

  if (event === 'PING') {
    return res.json({ status: 'PONG', connected: true, voltage: currentVoltage });
  }

  // Lectura Real de Tarjeta RFID (RC522)
  if (event === 'RFID_SCAN') {
    const card = cards.find(c => c.id === cardId);

    if (!card) {
      addLog('ACCESS_DENIED', `Tarjeta física desconocida escaneada: ${cardId}`, cardId);
      lockerState.isAlarm = true;
      io.emit('update_locker', lockerState);

      // Abrir modal flotante en React
      io.emit('unknown_card_scanned', { cardId });

      return res.json({ action: 'DENY', reason: 'CARD_NOT_FOUND', cardId, buzzer: true });
    }

    if (!card.active) {
      addLog('ACCESS_DENIED', `Acceso denegado: Tarjeta inactiva (${card.owner})`, cardId, card.owner);
      return res.json({ action: 'DENY', reason: 'CARD_INACTIVE', buzzer: true });
    }

    if (!card.isPaid) {
      addLog('ACCESS_DENIED', `Acceso denegado: Membresía morosa (${card.owner})`, cardId, card.owner);
      return res.json({ action: 'DENY', reason: 'MEMBERSHIP_EXPIRED', buzzer: true });
    }

    lockerState.isOpen = true;
    lockerState.servoAngle = 90;
    lockerState.lastCardScanned = cardId;
    
    addLog('ACCESS_GRANTED', `Acceso concedido a ${card.owner}`, cardId, card.owner);
    io.emit('update_locker', lockerState);

    setTimeout(() => {
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);
    }, 4000);

    return res.json({ action: 'ALLOW', servoAngle: 90, buzzer: false });
  }

  // Sensor SW-420
  if (event === 'DOOR_FORCED' || forced === true) {
    lockerState.isAlarm = true;
    addLog('FORCED_ALARM', '¡ALERTA FÍSICA! Vibración/Forzado detectado por sensor SW-420');
    io.emit('update_locker', lockerState);
    return res.json({ action: 'TRIGGER_ALARM', buzzer: true });
  }

  // Sensor HC-SR04
  if (event === 'OBJECT_STATUS') {
    lockerState.forgottenObjects = objectDetected;
    if (objectDetected) {
      addLog('WARNING', 'Sensor HC-SR04 reportó pertenencia dentro del casillero');
    } else {
      addLog('INFO', 'Sensor HC-SR04 reportó casillero vacío');
    }
    io.emit('update_locker', lockerState);
    return res.json({ status: 'ACK' });
  }

  res.status(400).json({ error: 'Evento Webhook no reconocido' });
});

io.on('connection', (socket) => {
  socket.emit('update_locker', lockerState);
  socket.emit('update_cards', cards);
  socket.emit('hardware_status', { connected: isEsp32Connected, voltage: currentVoltage });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Real IoT corriendo en: http://localhost:${PORT}`);
});