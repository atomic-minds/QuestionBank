// Runs before the page paints so a saved light/dark choice never flashes the wrong colours.
try { var t = localStorage.getItem('qb.theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* no storage: follow the device */ }
