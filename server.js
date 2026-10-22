// --- ENDPOINT WEBHOOK RECEPTOR RFID ---
app.post('/api/webhook', (req, res) => {
  const { event, tipo_evento, cardId, uid, valor, forced } = req.body;

  lastEsp32Ping = Date.now();
  const eventType = event || tipo_evento;
  const rawUid = cardId || uid || valor || '';
  const idTarjeta = rawUid.toString().toUpperCase().trim();

  if (eventType === 'RFID_SCAN' || eventType === 'rfid_lectura') {
    let card = cards.find(c => c.id === idTarjeta);

    // Si la tarjeta escaneada es nueva (como la de Willian), se asigna
    if (!card && idTarjeta.length >= 4) {
      card = {
        id: idTarjeta,
        owner: `Willian V. (${idTarjeta})`,
        isPaid: true,
        active: true,
        cardCode: `CARD_${idTarjeta.substring(0, 4)}`
      };
      cards.push(card);
      io.emit('update_cards', cards);
    }

    console.log(`[LECTURA RFID] UID: ${idTarjeta} | Socio: ${card ? card.owner : 'Desconocido'}`);

    // NOTIFICAR EN TIEMPO REAL A REACT
    io.emit('card_scanned', {
      uid: idTarjeta,
      cardCode: card ? card.cardCode : `UID_${idTarjeta}`,
      userName: card ? card.owner : 'Desconocido'
    });

    // ❌ CASO 1: TARJETA INACTIVA -> MANTENER CERRADO (SERVO 0°)
    if (!card.active) {
      addLog('ACCESS_DENIED', `Acceso denegado: Tarjeta inactiva (${card.owner})`, idTarjeta, card.owner);
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);

      return res.json({ action: 'DENY', reason: 'CARD_INACTIVE', servoAngle: 0, buzzer: true });
    }

    // ❌ CASO 2: SOCIO MOROSO -> MANTENER CERRADO (SERVO 0°)
    if (!card.isPaid) {
      addLog('ACCESS_DENIED', `Acceso denegado: Membresía morosa (${card.owner})`, idTarjeta, card.owner);
      lockerState.isOpen = false;
      lockerState.servoAngle = 0;
      io.emit('update_locker', lockerState);

      return res.json({ action: 'DENY', reason: 'MEMBERSHIP_EXPIRED', servoAngle: 0, buzzer: true });
    }

    // ✅ CASO 3: ACCESO PERMITIDO -> ABRIR SERVO A 90°
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

  res.status(400).json({ error: 'Evento Webhook no reconocido' });
});