import { boot } from './server-v2.mjs';
boot().catch(() => { console.error('amalia_events_startup_failed'); process.exit(1); });
