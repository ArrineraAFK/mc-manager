// ── DDNS Provider Templates ────────────────────────────────────────
// Jeder Provider definiert wie seine Update-URL aufgebaut ist.
// Neuen Provider hinzufügen: einfach ein Objekt unten in DDNS_PROVIDERS einfügen.

const DDNS_PROVIDERS = {
  duckdns: {
    label: 'DuckDNS',
    domainSuffix: '.duckdns.org',
    fields: [
      { key: 'domain', label: 'Subdomain', placeholder: 'meinserver' },
      { key: 'token',  label: 'Token', placeholder: 'DuckDNS Token', type: 'password' }
    ],
    buildUrl: ({ domain, token }) => `https://www.duckdns.org/update?domains=${domain}&token=${token}&ip=`,
    parseResponse: (body) => {
      const ok = body.trim().toUpperCase().startsWith('OK');
      return { ok, error: ok ? null : `DuckDNS: ${body.trim()}` };
    },
    fullDomain: ({ domain }) => `${domain}.duckdns.org`
  },

  noip: {
    label: 'No-IP',
    domainSuffix: '',
    fields: [
      { key: 'domain', label: 'Hostname', placeholder: 'meinserver.ddns.net' },
      { key: 'user',   label: 'Benutzername', placeholder: 'user@email.com' },
      { key: 'pass',   label: 'Passwort', placeholder: 'Passwort', type: 'password' }
    ],
    buildUrl: ({ domain, user, pass }) => {
      const auth = Buffer.from(`${user}:${pass}`).toString('base64');
      return { url: `https://dynupdate.no-ip.com/nic/update?hostname=${domain}`, headers: { Authorization: `Basic ${auth}` } };
    },
    parseResponse: (body) => {
      const ok = /^(good|nochg)/i.test(body.trim());
      return { ok, error: ok ? null : `No-IP: ${body.trim()}` };
    },
    fullDomain: ({ domain }) => domain
  },

  custom: {
    label: 'Eigene URL (anderer Anbieter)',
    domainSuffix: '',
    fields: [
      { key: 'displayDomain', label: 'Anzeige-Adresse (für Join-Adresse)', placeholder: 'meinserver.beispiel.com' },
      { key: 'customUrl', label: 'Update-URL', placeholder: 'https://anbieter.de/update?host={domain}&key={token}&ip={ip}', type: 'text', isUrlTemplate: true },
      { key: 'token', label: 'Token / API-Key (optional)', placeholder: 'Token falls benötigt', type: 'password' }
    ],
    buildUrl: ({ customUrl, displayDomain, token }) => {
      return customUrl
        .replace('{domain}', encodeURIComponent(displayDomain || ''))
        .replace('{token}', encodeURIComponent(token || ''))
        .replace('{ip}', '');
    },
    parseResponse: (body, status) => {
      const ok = status >= 200 && status < 300;
      return { ok, error: ok ? null : `HTTP ${status}: ${body.slice(0, 200)}` };
    },
    fullDomain: ({ domain }) => {
        const clean = domain.replace(/\.duckdns\.org$/i, '');
        return `${clean}.duckdns.org`;
    }
  }
};

function getProviderList() {
  return Object.entries(DDNS_PROVIDERS).map(([key, p]) => ({ key, label: p.label }));
}

function getProvider(key) {
  return DDNS_PROVIDERS[key] || null;
}

module.exports = { DDNS_PROVIDERS, getProviderList, getProvider };