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

// SOCIOS POR DEFECTO PARA QUE LA PANTALLA NO QUEDE VACÍA AL INICIAR
let cards = [
  { id: 'B943AA14', owner: 'Carlos Pérez', isPaid: true, active: true, cardCode: 'CARD_VIP_01' },
  { id: 'E5F6G7H8', owner: 'María Gómez', isPaid: false, active: true, cardCode: 'CARD_EXPIRED_02' },
  { id: 'I9J0K1L2', owner: 'Juan Rodríguez', isPaid: true, active: false, cardCode: 'CARD_LOST_03' }
];

let lockerState = {
  isOpen: false,
  isAlarm: false,
  forgottenObjects: false,
  servoAngle: 0,
  lastCardScanned: null
};

let isEsp32Connected = false;
let lastEsp32Ping = null;
let currentVoltage = 5.0;
let auditLogs = [];

const addLog = (type, message, cardId = null, user = 'Sistema') => {
  const log = {
    id: Date.now(),
    type,
    message,
    cardId,
    user,
    timestamp: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };
  auditLogs.unshift(log);
  if (auditLogs.length > 50) auditLogs.pop();
  
  // Emitir evento de log a la pantalla
  io.emit('new_log', log);
  return log;
};

// Monitor de presencia y pérdida de energía del ESP32
setInterval(() => {
  if (lastEsp32Ping && (Date.now() - lastEsp32Ping > 8000)) {
    if (isEsp32Connected) {
      isEsp32Connected = false;
      currentVoltage = 0.0;
      addLog('WARNING', 'ESP32 fuera de línea / Alimentación cortada');
      
      io.emit('telemetry_update', { connected: false, voltage: 0.0 });
    }
  }
}, 3000);

// --- RUTAS API REST ---
app.get('/api/cards', (req, res) => res.json(cards));

app.post('/api/cards', (req, res) => {
  const { id, owner } = req.body;
  if (!id || !owner) return res.status(400).json({ error: 'Faltan datos requeridos' });

  const cleanId = id.toUpperCase();
  const existingCard = cards.find(c => c.id === cleanId);
  
  if (existingCard) {
    existingCard.owner = owner;
  } else {
    cards.push({ 
      id: cleanId, 
      owner, 
      isPaid: true, 
      active: true, 
      cardCode: `CARD_${cleanId.substring(0, 4)}` 
    });
  }

  addLog('INFO', `Socio/Tarjeta registrado(a): ${owner} (${cleanId})`, cleanId, owner);
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
  const { event, tipo_evento, cardId, uid, forced, objectDetected, distance, voltage } = req.body;

  lastEsp32Ping = Date.now();

  // Compatibilidad de parámetros recibidos desde el ESP32
  const eventType = event || tipo_evento;
  const idTarjeta = (cardId || uid || '').toUpperCase();

  // Lectura de Voltaje
  if (voltage !== undefined && voltage !== null) {
    currentVoltage = parseFloat(voltage);
  } else if (!isEsp32Connected) {
    currentVoltage = 5.0;
  }

  if (!isEsp32Connected) {
    isEsp32Connected = true;
    addLog('INFO', `Hardware ESP32 enlazado (${currentVoltage.toFixed(1)}V)`);
  }

  // Transmitir Telemetría compatible hacia el Frontend
  io.emit('telemetry_update', { 
    connected: true, 
    voltage: currentVoltage,
    distance: distance !== undefined ? distance : (objectDetected ? 10 : 25),
    vibration: forced || false
  });

  if (eventType === 'PING') {
    return res.json({ status: 'PONG', connected: true, voltage: currentVoltage });
  }

  // 1. LECTURA REAL DE TARJETA RFID (RC522)
  if (eventType === 'RFID_SCAN' || eventType === 'rfid_lectura') {
    const card = cards.find(c => c.id === idTarjeta);

    // ⚡ CLAVE: TRANSMITIR EVENTO AL FRONTEND REACT EN TIEMPO REAL
    io.emit('card_scanned', {
      uid: idTarjeta,
      cardCode: card ? card.cardCode : `UID_${idTarjeta}`,
      userName: card ? card.owner : 'Desconocido'
    });

    if (!card) {
      addLog('ACCESS_DENIED', `Tarjeta física desconocida escaneada: ${idTarjeta}`, idTarjeta);
      lockerState.isAlarm = true;
      io.emit('update_locker', lockerState);
      io.emit('unknown_card_scanned', { cardId: idTarjeta });

      return res.json({ action: 'DENY', reason: 'CARD_NOT_FOUND', cardId: idTarjeta, buzzer: true });
    }

    if (!card.active) {
      addLog('ACCESS_DENIED', `Acceso denegado: Tarjeta inactiva (${card.owner})`, idTarjeta, card.owner);
      return res.json({ action: 'DENY', reason: 'CARD_INACTIVE', buzzer: true });
    }

    if (!card.isPaid) {
      addLog('ACCESS_DENIED', `Acceso denegado: Membresía morosa (${card.owner})`, idTarjeta, card.owner);
      return res.json({ action: 'DENY', reason: 'MEMBERSHIP_EXPIRED', buzzer: true });
    }

    // ACCESO CONCEDIDO (Apertura por 4 Segundos)
    lockerState.isOpen = true;
    lockerState.servoAngle = 90;
    lockerState.lastCardScanned = idTarjeta;
    
    addLog('ACCESS_GRANTED', `Acceso concedido a ${card.owner}`, idTarjeta, card.owner);
    io.emit('update_locker', lockerState);

    setTimeout(() => {
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);
    }, 4000);

    return res.json({ action: 'ALLOW', servoAngle: 90, buzzer: false });
  }

  // 2. SENSOR DE IMPACTO / VIBRACIÓN SW-420
  if (eventType === 'DOOR_FORCED' || eventType === 'vibracion_alerta' || forced === true) {
    lockerState.isAlarm = true;
    addLog('FORCED_ALARM', '¡ALERTA FÍSICA! Vibración/Forzado detectado por sensor SW-420');
    
    io.emit('update_locker', lockerState);
    io.emit('telemetry_update', { vibration: true });

    return res.json({ action: 'TRIGGER_ALARM', buzzer: true });
  }

  // 3. SENSOR ULTRASÓNICO HC-SR04
  if (eventType === 'OBJECT_STATUS') {
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
  socket.emit('telemetry_update', { connected: isEsp32Connected, voltage: currentVoltage });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor IoT en tiempo real ejecutándose en puerto: ${PORT}`);
});