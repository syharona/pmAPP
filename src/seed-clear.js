// Supprime les données de démonstration : npm run seed:clear [-- --yes]
import readline from 'node:readline/promises';
import { config } from './config.js';
import { openDb } from './db.js';
import { clearDemoData, describeCounts, findDemoData } from './demo.js';

// Si l'app tourne, elle garde sa propre copie de la base (sql.js) : on passe par elle.
const running = await fetch(`http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}/api/session`, { signal: AbortSignal.timeout(1000) })
  .then(() => true)
  .catch(() => false);
if (running) {
  console.log("L'app est en cours d'exécution : arrête-la (Ctrl+C) puis relance cette commande,\nou utilise le bouton Réglages → Données de démonstration dans l'app.");
  process.exit(1);
}

const repo = openDb(config.dbPath);
const found = findDemoData(repo);
if (!found.projects.length && !found.orphanActionIds.length && !found.emailIds.length) {
  console.log('Aucune donnée de démonstration trouvée.');
  process.exit(0);
}
console.log(`Projets de démo : ${found.projects.map((p) => `${p.code} (${p.name})`).join(', ') || 'aucun'}`);
console.log(`Sera supprimé : ${describeCounts(found.counts)}.`);
if (found.projects.length) console.log('⚠ Tout ce que tu as ajouté dans ces projets sera supprimé aussi.');

if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Confirmer la suppression ? (o/N) ');
  rl.close();
  if (!/^o(ui)?$|^y(es)?$/i.test(answer.trim())) {
    console.log('Annulé.');
    process.exit(0);
  }
}
const counts = clearDemoData(repo);
repo.db.flush?.(); // sql.js : écrit le fichier tout de suite
console.log(`Supprimé : ${describeCounts(counts)}.`);
