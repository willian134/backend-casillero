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

// BASE DE DATOS DE SOCIOS (Asegúrate de colocar los UIDs exactos que lee tu Monitor Serie)
let cards = [
  { id: 'B943AA14', owner: 'Carlos Pérez', isPaid: true, active: true, cardCode: 'CARD_VIP_01' },
  { id: 'E5F6G7H8', owner: 'María Gómez', isPaid: false, active: true, cardCode: 'CARD_EXPIRED_02' },  // MOROSA -> Bloquea Servo
  { id: 'A1B2C3D4', owner: 'Willian V.', isPaid: true, active: true, cardCode: 'CARD_WILLIAN_03' }
];

let lockerState = { isOpen: false, isAlarm: false, servoAngle: 0 };
let auditLogs = [];

const addLog = (type, message, cardId = null, user = 'Sistema') => {
  const log = { id: Date.now(), type, message, cardId, user, timestamp: new Date().toLocaleTimeString('es-ES') };
  auditLogs.unshift(log);
  io.emit('new_log', log);
  return log;
};

// --- WEBHOOK RECEPTOR RFID ---
app.post('/api/webhook', (req, res) => {
  const { event, tipo_evento, cardId, uid, valor } = req.body;
  const rawUid = cardId || uid || valor || '';
  const idTarjeta = rawUid.toString().toUpperCase().trim();
  const eventType = event || tipo_evento;

  if (eventType === 'RFID_SCAN' || eventType === 'rfid_lectura') {
    const card = cards.find(c => c.id.toUpperCase() === idTarjeta);

    console.log(`[ESCANEO] UID: ${idTarjeta} | Socio: ${card ? card.owner : 'Desconocido'}`);

    // Transmitir inmediatamente al React via Sockets
    io.emit('card_scanned', {
      uid: idTarjeta,
      cardCode: card ? card.cardCode : `UID_${idTarjeta}`,
      userName: card ? card.owner : 'Desconocido'
    });

    // 1. Tarjeta No Registrada -> DENY (Servo a 0°)
    if (!card) {
      addLog('ACCESS_DENIED', `Tarjeta no registrada: ${idTarjeta}`, idTarjeta);
      return res.json({ action: 'DENY', reason: 'CARD_NOT_FOUND', servoAngle: 0, buzzer: true });
    }

    // 2. Socio Moroso o Tarjeta Inactiva -> DENY (Servo a 0°)
    if (!card.active || !card.isPaid) {
      addLog('ACCESS_DENIED', `Acceso denegado: ${card.owner} (Moroso o Inactivo)`, idTarjeta, card.owner);
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);

      return res.json({ action: 'DENY', reason: 'MEMBERSHIP_EXPIRED', servoAngle: 0, buzzer: true });
    }

    // 3. Socio al día y Tarjeta Activa -> ALLOW (Servo a 90°)
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

  res.status(400).json({ error: 'Evento no reconocido' });
});

app.get('/api/cards', (req, res) => res.json(cards));

app.put('/api/cards/:id/membership', (req, res) => {
  const { id } = req.params;
  const { isPaid } = req.body;
  cards = cards.map(c => c.id.toUpperCase() === id.toUpperCase() ? { ...c, isPaid } : c);
  io.emit('update_cards', cards);
  res.json({ success: true, cards });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Servidor backend en puerto ${PORT}`));