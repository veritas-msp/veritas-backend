// Middleware pour vérifier le mode maintenance
// Mode informatif uniquement : affiche un message sur la page de login, ne bloque pas l'application
// Le statut de maintenance est récupéré via l'endpoint /api/maintenance/status qui est accessible publiquement
export async function checkMaintenanceMode(req, res, next) {
  // Le mode maintenance est maintenant uniquement informatif
  // Il n'y a plus de blocage des requêtes - le message s'affiche uniquement sur la page de login
  next();
}

