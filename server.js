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

let cards = [
  { id: 'B943AA14', owner: 'Carlos Pérez', isPaid: true, active: true, cardCode: 'CARD_VIP_01' },
  { id: 'C82F0059', owner: 'María Gómez', isPaid: false, active: true, cardCode: 'CARD_EXPIRED_02' },
  { id: '738F1492', owner: 'Willian V.', isPaid: true, active: true, cardCode: 'CARD_WILLIAN_03' }
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
  io.emit('new_log', log);
  return log;
};

// --- WEBHOOK RECEPTOR ---
app.post('/api/webhook', (req, res) => {
  const { event, tipo_evento, cardId, uid, valor } = req.body;
  const rawUid = cardId || uid || valor || '';
  const idTarjeta = rawUid.toString().toUpperCase().trim();
  const eventType = event || tipo_evento;

  // 🚨 DETECCIÓN DE FORCEJEO (SW-420)
  if (eventType === 'DOOR_FORCED') {
    console.log("🚨 [ALERTA] ¡Intento de forcejeo detectado en la puerta!");
    
    addLog('DANGER', '¡ALERTA DE SEGURIDAD! Vibración / Intentos de forcejeo en la puerta', null, 'Sensor SW-420');
    
    // Emitir alerta inmediata al Frontend React a través de WebSockets
    io.emit('telemetry_update', { vibration: true });

    return res.json({ action: 'ALARM_ACKNOWLEDGED', buzzer: true });
  }

  // 💳 LECTURA RFID
  if (eventType === 'RFID_SCAN' || eventType === 'rfid_lectura') {
    const card = cards.find(c => c.id.toUpperCase().trim() === idTarjeta);

    io.emit('card_scanned', {
      uid: idTarjeta,
      cardCode: card ? card.cardCode : `UID_${idTarjeta}`,
      userName: card ? card.owner : 'Desconocido'
    });

    if (!card) {
      addLog('ACCESS_DENIED', `Tarjeta no registrada: ${idTarjeta}`, idTarjeta);
      return res.json({ action: 'DENY', reason: 'CARD_NOT_FOUND', servoAngle: 0, buzzer: true });
    }

    if (!card.active || !card.isPaid) {
      const motivo = !card.active ? 'Tarjeta Inactiva' : 'Membresía Morosa';
      addLog('ACCESS_DENIED', `Acceso denegado a ${card.owner} (${motivo})`, idTarjeta, card.owner);
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);

      return res.json({ action: 'DENY', reason: 'DENIED_STATUS', servoAngle: 0, buzzer: true });
    }

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

app.get('/api/cards', (req, res) => res.json(cards));

app.put('/api/cards/:id/membership', (req, res) => {
  const { id } = req.params;
  const { isPaid } = req.body;
  const cleanId = id.toUpperCase().trim();
  cards = cards.map(c => c.id.toUpperCase().trim() === cleanId ? { ...c, isPaid: Boolean(isPaid) } : c);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

app.put('/api/cards/:id', (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  const cleanId = id.toUpperCase().trim();
  cards = cards.map(c => c.id.toUpperCase().trim() === cleanId ? { ...c, active: Boolean(active) } : c);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Backend en puerto ${PORT}`));