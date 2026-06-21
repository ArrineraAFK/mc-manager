function selectMode(mode) {
  if (mode === 'server') {
    window.modeApi.setMode('server');
    return;
  }
  // Client-Modus: Formular zeigen
  document.getElementById('clientForm').style.display = 'flex';
}

function cancelClientForm() {
  document.getElementById('clientForm').style.display = 'none';
  document.getElementById('connError').style.display = 'none';
}

async function connectToServer() {
  const host = document.getElementById('connHost').value.trim();
  const port = document.getElementById('connPort').value.trim() || '4127';
  const errEl = document.getElementById('connError');

  if (!host) {
    errEl.style.display = 'block';
    errEl.textContent = 'Bitte eine Server-Adresse eingeben.';
    return;
  }

  errEl.style.display = 'none';

  const res = await window.modeApi.testConnection({ host, port });
  if (res.ok) {
    window.modeApi.setMode('client', { host, port });
  } else {
    errEl.style.display = 'block';
    errEl.textContent = 'Verbindung fehlgeschlagen: ' + (res.error || 'Unbekannter Fehler');
  }
}