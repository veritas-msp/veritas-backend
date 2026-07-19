// Middleware to check maintenance mode
// Informational mode only: shows a message on the login page, does not block the application
// Maintenance status is fetched via the public /api/maintenance/status endpoint
export async function checkMaintenanceMode(req, res, next) {
  // Maintenance mode is now informational only
  // Requests are no longer blocked — the message appears only on the login page
  next();
}

