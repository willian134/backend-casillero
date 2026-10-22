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

// BASE DE DATOS MIGRADA CON LOS 3 UIDS FÍSICOS REALES
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
    isPaid: false, // Morosa por defecto
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
  io.emit('new_log', log);
  return log;
};

// --- ENDPOINT WEBHOOK RECEPTOR RFID ---
app.post('/api/webhook', (req, res) => {
  const { event, tipo_evento, cardId, uid, valor } = req.body;
  const rawUid = cardId || uid || valor || '';
  const idTarjeta = rawUid.toString().toUpperCase().trim();
  const eventType = event || tipo_evento;

  if (eventType === 'RFID_SCAN' || eventType === 'rfid_lectura') {
    // Buscar la tarjeta comparando en mayúsculas
    const card = cards.find(c => c.id.toUpperCase().trim() === idTarjeta);

    console.log(`[ESCANEO REAL] UID: ${idTarjeta} | Socio: ${card ? card.owner : 'Desconocido'}`);

    // Emitir Socket al Frontend React
    io.emit('card_scanned', {
      uid: idTarjeta,
      cardCode: card ? card.cardCode : `UID_${idTarjeta}`,
      userName: card ? card.owner : 'Desconocido'
    });

    // ⛔ REGLA DE BLOQUEO 1: TARJETA NO REGISTRADA
    if (!card) {
      addLog('ACCESS_DENIED', `Tarjeta no registrada: ${idTarjeta}`, idTarjeta);
      return res.json({ action: 'DENY', reason: 'CARD_NOT_FOUND', servoAngle: 0, buzzer: true });
    }

    // ⛔ REGLA DE BLOQUEO 2: SOCIO MOROSO O TARJETA DESACTIVADA
    if (!card.active || !card.isPaid) {
      const motivo = !card.active ? 'Tarjeta Inactiva' : 'Membresía Morosa';
      addLog('ACCESS_DENIED', `Acceso denegado a ${card.owner} (${motivo})`, idTarjeta, card.owner);
      
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);

      // RETORNA STRICTAMENTE DENY PARA QUE EL ESP32 MANTENGA EL SERVO EN 0°
      return res.json({ action: 'DENY', reason: 'DENIED_STATUS', servoAngle: 0, buzzer: true });
    }

    // ✅ CASO ÚNICO AUTORIZADO: SOCIO AL DÍA Y ACTIVO
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

// RUTAS API REST SINCRONIZADAS
app.get('/api/cards', (req, res) => res.json(cards));

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

// CAMBIAR ESTADO ACTIVO / INACTIVO
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
server.listen(PORT, () => console.log(`🚀 Servidor backend en puerto ${PORT}`));