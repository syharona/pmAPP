// Données de démonstration : npm run seed (n'écrase rien si des projets existent déjà).
import { config } from './config.js';
import { openDb } from './db.js';
import { addDays, todayISO } from './dates.js';

const repo = openDb(config.dbPath);
if (repo.listProjects({ includeArchived: true }).length && !process.argv.includes('--force')) {
  console.log('Des projets existent déjà — rien à faire (utilise --force pour ajouter quand même).');
  process.exit(0);
}

const t = todayISO();
const d = (n) => addDays(t, n);

const projects = [
  { code: 'CRM', name: 'Refonte CRM commercial', aliases: 'salesforce,crm', sponsor: 'Dir. commerciale', phase: 'Build', rag: 'green', progress: 45, start_date: d(-90), deadline: d(40) },
  { code: 'ERP', name: 'Migration ERP finance', aliases: 'sap,s4', sponsor: 'DAF', phase: 'Recette', rag: 'green', progress: 60, start_date: d(-150), deadline: d(12), ttm: 1, status_note: 'Go-live maintenu, recette sous tension : arbitrage attendu en COPIL sur le périmètre paie.' },
  { code: 'OFFRE', name: 'Lancement offre Pro 2027', aliases: 'offre pro,lancement', sponsor: 'Dir. marketing', phase: 'Conception', rag: 'green', progress: 20, start_date: d(-30), deadline: d(95), ttm: 1 },
  { code: 'DATA', name: 'Plateforme data RH', aliases: 'datalake,rh', sponsor: 'DRH', phase: 'Cadrage', rag: 'amber', progress: 15, start_date: d(-20), deadline: d(120) },
  { code: 'M365', name: 'Déploiement Teams / M365', aliases: 'teams,sharepoint', sponsor: 'DSI', phase: 'Déploiement', rag: 'green', progress: 80, start_date: d(-200), deadline: d(25) },
].map((p) => repo.insert('projects', p));
const [crm, erp, offre, data, m365] = projects;

// Rétroplannings (projets à deadline imposée)
const retro = (project, steps) =>
  steps.forEach(([title, duration_days, status = 'todo', owner = '', remaining_days = null]) => repo.addRetroStep({ project_id: project.id, title, duration_days, status, owner, remaining_days }));
retro(erp, [['Recette lot comptabilité', 8, 'doing', 'Sophie', 5], ['Recette lot paie', 3], ['Go/no-go COPIL', 1], ['Bascule & mise en production', 2]]);
retro(offre, [['Étude marché & pricing', 10, 'done'], ['Spécifications produit', 12, 'doing', 'Karim', 8], ['Développement', 30], ['Tests & conformité', 10], ['Formation forces de vente', 5], ['Lancement commercial', 1]]);

const actions = [
  [crm.id, 'Valider les maquettes écran opportunités', 'moi', d(-2), 'high'],
  [crm.id, 'Envoyer le planning révisé au sponsor', 'moi', t, 'normal'],
  [crm.id, 'Chiffrer le lot 2 (intégration ERP)', 'Paul', d(3), 'normal', 'waiting'],
  [erp.id, 'Relancer le fournisseur sur les correctifs recette', 'moi', d(-4), 'critical'],
  [erp.id, 'PV de recette lot comptabilité', 'Sophie', d(-1), 'high', 'waiting'],
  [erp.id, 'Préparer le comité de pilotage go/no-go', 'moi', d(5), 'high'],
  [data.id, 'Organiser l\'atelier besoins avec la DRH', 'moi', d(2), 'normal'],
  [data.id, 'Obtenir l\'avis DPO sur les données sensibles', 'Karim', d(10), 'normal', 'waiting'],
  [m365.id, 'Plan de communication vague 3', 'moi', d(8), 'normal'],
  [null, 'Rappeler Julie (achats) sur le contrat cadre', 'moi', d(1), 'normal'],
];
for (const [project_id, title, owner, due_date, priority, status = 'todo'] of actions) {
  repo.createAction({ project_id, title, owner, due_date, priority, status, source: 'web' });
}

const risks = [
  [erp.id, 'Correctifs fournisseur livrés trop tard pour la recette', 4, 5],
  [erp.id, 'Indisponibilité des key users pendant la clôture', 3, 4],
  [crm.id, 'Dépendance à l\'API ERP non stabilisée', 3, 3],
  [data.id, 'Blocage juridique sur les données RH', 2, 5],
  [m365.id, 'Résistance au changement équipes terrain', 3, 2],
];
for (const [project_id, title, probability, impact] of risks) repo.createRisk({ project_id, title, probability, impact });
// Simule une hausse récente d'un risque CRM
const crmRisk = repo.listRisks({ projectId: crm.id })[0];
repo.db.prepare(`UPDATE risk_history SET at = datetime('now','-20 days') WHERE risk_id = ?`).run(crmRisk.id);
repo.updateRisk(crmRisk.id, { probability: 4, impact: 4 });

repo.insert('milestones', { project_id: erp.id, title: 'Fin de recette', due_date: d(-3) });
repo.insert('milestones', { project_id: erp.id, title: 'Go-live', due_date: d(12) });
repo.insert('milestones', { project_id: crm.id, title: 'Démo sprint 6', due_date: d(9) });
repo.insert('milestones', { project_id: m365.id, title: 'Vague 3', due_date: d(18) });

repo.addJournal({ project_id: crm.id, kind: 'change', text: 'Ajout du module devis au périmètre (demande Dir. commerciale)' });
repo.addJournal({ project_id: erp.id, kind: 'decision', text: 'Go-live maintenu, plan de contournement pour la paie' });
repo.addJournal({ project_id: erp.id, kind: 'change', text: 'Recette lot 2 décalée d\'une semaine' });

repo.insert('emails', {
  subject: 'CR point hebdo CRM',
  sender: 'Paul Martin <paul.martin@example.com>',
  body: `Bonjour,

Suite au point de ce matin :
Actions :
- Paul : finaliser le chiffrage du lot 2 pour vendredi
- Merci de valider les maquettes avant le 15/10
- Organiser la démo sprint 6 avec les commerciaux

Point d'attention : l'API ERP n'est toujours pas stable, risque de retard sur l'intégration.
Le go-live pilote est décalé au 20/11.

Cordialement,
Paul`,
  source: 'demo',
});

repo.setSettings({ me_name: 'Moi', me_aliases: '' });
console.log(`Démo créée : ${projects.length} projets.`);
