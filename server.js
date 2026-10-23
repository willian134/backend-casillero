import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = http.createServer(app);

// CONFIGURACIÓN DE SOCKET.IO CON CORS ABIERTO Y POLLING DE RESPALDO
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors({ origin: '*' }));
app.use(express.json());

// BASE DE DATOS EN MEMORIA CON LOS UIDS FÍSICOS REALES
let cards = [
  { 
    id: 'B943AA14', 
    owner: 'Carlos Pérez', 
    isPaid: true, 
    active: true, 
    cardCode: 'CARD_VIP_01' 
  },
  { 
    id: 'C82F0059', 
    owner: 'María Gómez', 
    isPaid: false, // Morosa -> Mantiene servo en 0°
    active: true, 
    cardCode: 'CARD_EXPIRED_02' 
  },
  { 
    id: '738F1492', 
    owner: 'Willian V.', 
    isPaid: true, 
    active: true, 
    cardCode: 'CARD_WILLIAN_03' 
  }
];

let lockerState = { isOpen: false, isAlarm: false, servoAngle: 0 };
let auditLogs = [];

const addLog = (type, message, cardId = null, user = 'Sistema') => {
  const log = { 
    id: Date.now(), 
    type, 
    message, 
    cardId, 
    user, 
    time: new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) 
  };
  auditLogs.unshift(log);
  if (auditLogs.length > 50) auditLogs.pop();
  
  // Emisión global e inmediata a todos los clientes conectados en Vercel
  io.emit('new_log', log);
  return log;
};

// ==========================================
// CANAL DE COMUNICACIÓN CON SOCKET.IO
// ==========================================
io.on('connection', (socket) => {
  console.log(`🔌 Cliente Web Conectado: ${socket.id}`);
  
  // Sincronizar estado inicial apenas se abre la página en React
  socket.emit('update_cards', cards);
  socket.emit('update_locker', lockerState);

  socket.on('disconnect', () => {
    console.log(`❌ Cliente Web Desconectado: ${socket.id}`);
  });
});

// ==========================================
// RECEPTOR DE WEBHOOKS (ESP32)
// ==========================================
app.post('/api/webhook', (req, res) => {
  const { event, tipo_evento, cardId, uid, valor, distance, occupied } = req.body;
  const rawUid = cardId || uid || valor || '';
  const idTarjeta = rawUid.toString().toUpperCase().trim();
  const eventType = event || tipo_evento;

  // 📡 1. TRANSMISIÓN DE TELEMETRÍA ULTRASÓNICA AL FRONTEND (HC-SR04)
  if (distance !== undefined || occupied !== undefined) {
    io.emit('telemetry_update', {
      distance: distance !== undefined ? parseFloat(distance) : 999,
      occupied: Boolean(occupied)
    });
  }

  // 🚨 2. ALERTA DE FORCEJEO / VIBRACIÓN (SENSOR SW-420)
  if (eventType === 'DOOR_FORCED') {
    console.log("🚨 [ALERTA DE SEGURIDAD] Impacto detectado por SW-420 en la puerta");
    
    addLog('DANGER', '¡ALERTA DE SEGURIDAD! Vibración / Forcejeo detectado en la puerta', null, 'Sensor SW-420');
    
    // Activa el banner rojo inmediatamente en el dashboard
    io.emit('telemetry_update', { vibration: true });

    return res.json({ action: 'ALARM_ACKNOWLEDGED', buzzer: true });
  }

  // 💳 3. ESCANEO DE TARJETA RFID (RC522)
  if (eventType === 'RFID_SCAN' || eventType === 'rfid_lectura') {
    const card = cards.find(c => c.id.toUpperCase().trim() === idTarjeta);

    console.log(`[ESCANEO REAL] UID: ${idTarjeta} | Socio: ${card ? card.owner : 'Desconocido'}`);

    // Transmitir lectura al panel de React sin demoras
    io.emit('card_scanned', {
      uid: idTarjeta,
      cardCode: card ? card.cardCode : `UID_${idTarjeta}`,
      userName: card ? card.owner : 'Desconocido'
    });

    // ⛔ CASO A: TARJETA NO REGISTRADA
    if (!card) {
      addLog('ACCESS_DENIED', `Tarjeta no registrada: ${idTarjeta}`, idTarjeta);
      return res.json({ action: 'DENY', reason: 'CARD_NOT_FOUND', servoAngle: 0, buzzer: true });
    }

    // ⛔ CASO B: SOCIO MOROSO O TARJETA INACTIVA
    if (!card.active || !card.isPaid) {
      const motivo = !card.active ? 'Tarjeta Inactiva' : 'Membresía Morosa';
      addLog('ACCESS_DENIED', `Acceso denegado a ${card.owner} (${motivo})`, idTarjeta, card.owner);
      
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);

      // RETORNA STRICTAMENTE DENY -> ESP32 MANTENDRÁ EL SERVO A 0°
      return res.json({ action: 'DENY', reason: 'DENIED_STATUS', servoAngle: 0, buzzer: true });
    }

    // ✅ CASO C: SOCIO AUTORIZADO (AL DÍA Y ACTIVO)
    addLog('ACCESS_GRANTED', `Acceso concedido a ${card.owner}`, idTarjeta, card.owner);
    lockerState.isOpen = true;
    lockerState.servoAngle = 90;
    io.emit('update_locker', lockerState);

    setTimeout(() => {
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);
    }, 4000);

    return res.json({ action: 'ALLOW', servoAngle: 90, buzzer: false });
  }

  res.status(400).json({ error: 'Evento Webhook no reconocido' });
});

// ==========================================
// RUTAS API REST
// ==========================================
app.get('/api/cards', (req, res) => res.json(cards));

// REGISTRAR / EDITAR USUARIOS
app.post('/api/cards', (req, res) => {
  const { id, owner } = req.body;
  if (!id || !owner) return res.status(400).json({ error: 'Faltan datos' });

  const cleanId = id.toUpperCase().trim();
  const existingCard = cards.find(c => c.id.toUpperCase().trim() === cleanId);

  if (existingCard) {
    existingCard.owner = owner;
  } else {
    cards.push({ id: cleanId, owner, isPaid: true, active: true, cardCode: `CARD_${cleanId.substring(0, 4)}` });
  }

  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

// CAMBIAR PAGO / MOROSIDAD
app.put('/api/cards/:id/membership', (req, res) => {
  const { id } = req.params;
  const { isPaid } = req.body;
  const cleanId = id.toUpperCase().trim();
  
  cards = cards.map(c => c.id.toUpperCase().trim() === cleanId ? { ...c, isPaid: Boolean(isPaid) } : c);
  addLog('INFO', `Estado de pago de ${cleanId} actualizado a ${isPaid ? 'PAGADO' : 'MOROSO'}`);
  
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

// CAMBIAR HABILITAR / DESACTIVAR TARJETA
app.put('/api/cards/:id', (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  const cleanId = id.toUpperCase().trim();

  cards = cards.map(c => c.id.toUpperCase().trim() === cleanId ? { ...c, active: Boolean(active) } : c);
  addLog('INFO', `Estado de tarjeta ${cleanId} actualizado a ${active ? 'HABILITADA' : 'DESACTIVADA'}`);

  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Servidor backend activo en el puerto ${PORT}`));