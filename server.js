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

// BASE DE DATOS MIGRADA CON LOS UIDS FÍSICOS REALES DETECTADOS
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
    isPaid: false, // MOROSA -> ACCESO DENEGADO (SERVO CERRADO EN 0°)
    active: true, 
    cardCode: 'CARD_EXPIRED_02' 
  },
  { 
    id: '738F1492', 
    owner: 'Willian V.', 
    isPaid: true, // AL DÍA -> ACCESO CONCEDIDO (SERVO ABRE A 90°)
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
  io.emit('new_log', log);
  return log;
};

// --- WEBHOOK RECEPTOR RFID DINÁMICO ---
app.post('/api/webhook', (req, res) => {
  const { event, tipo_evento, cardId, uid, valor } = req.body;
  const rawUid = cardId || uid || valor || '';
  const idTarjeta = rawUid.toString().toUpperCase().trim();
  const eventType = event || tipo_evento;

  if (eventType === 'RFID_SCAN' || eventType === 'rfid_lectura') {
    const card = cards.find(c => c.id.toUpperCase() === idTarjeta);

    console.log(`[LECTURA RFID REAL] UID: ${idTarjeta} | Socio: ${card ? card.owner : 'Desconocido'}`);

    // NOTIFICAR EN TIEMPO REAL A REACT VÍA SOCKETS
    io.emit('card_scanned', {
      uid: idTarjeta,
      cardCode: card ? card.cardCode : `UID_${idTarjeta}`,
      userName: card ? card.owner : 'Desconocido'
    });

    // ⛔ CASO 1: TARJETA NO REGISTRADA -> SERVO EN 0°
    if (!card) {
      addLog('ACCESS_DENIED', `Tarjeta no registrada: ${idTarjeta}`, idTarjeta);
      return res.json({ action: 'DENY', reason: 'CARD_NOT_FOUND', servoAngle: 0, buzzer: true });
    }

    // ⛔ CASO 2: SOCIO MOROSO O TARJETA INACTIVA -> SERVO EN 0° (BLOQUEADO)
    if (!card.active || !card.isPaid) {
      addLog('ACCESS_DENIED', `Acceso denegado a ${card.owner} (Moroso/Inactivo)`, idTarjeta, card.owner);
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);

      return res.json({ action: 'DENY', reason: 'MEMBERSHIP_EXPIRED', servoAngle: 0, buzzer: true });
    }

    // ✅ CASO 3: SOCIO AUTORIZADO -> SERVO A 90°
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

// RUTAS API REST PARA GESTIÓN DESDE REACT
app.get('/api/cards', (req, res) => res.json(cards));

app.post('/api/cards', (req, res) => {
  const { id, owner } = req.body;
  if (!id || !owner) return res.status(400).json({ error: 'Faltan datos' });

  const cleanId = id.toUpperCase().trim();
  const existingCard = cards.find(c => c.id === cleanId);

  if (existingCard) {
    existingCard.owner = owner;
  } else {
    cards.push({ id: cleanId, owner, isPaid: true, active: true, cardCode: `CARD_${cleanId.substring(0, 4)}` });
  }

  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

app.put('/api/cards/:id/membership', (req, res) => {
  const { id } = req.params;
  const { isPaid } = req.body;
  cards = cards.map(c => c.id.toUpperCase() === id.toUpperCase() ? { ...c, isPaid } : c);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

app.put('/api/cards/:id', (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  cards = cards.map(c => c.id.toUpperCase() === id.toUpperCase() ? { ...c, active } : c);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Backend corriendo en puerto ${PORT}`));