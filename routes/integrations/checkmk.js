// ───────────────────────────────────────────────
// 📦 Check MK route — consolidated entry point
// ───────────────────────────────────────────────
// This file is the entry point and re-exports the modularized routes

import checkMKRouter from './checkmk/index.js';

export default checkMKRouter;

/*
  AVAILABLE ROUTES:
  
  📍 MAPPING:
  - GET /mapping/:clientId - Fetch mappings for a client
  - GET /mapping/:clientId/stats - Mapping statistics
  - POST /mapping - Create/update a mapping
  - DELETE /mapping/:id - Delete a mapping
  
  🏠 HOSTS:
  - GET /hosts - List all available hosts
  - GET /host/:hostName - Fetch host details
  - GET /availability-table/:hostName - Host availability table
  
  📋 SERVICES:
  - GET /services/:hostName - Fetch services for a host
  - GET /service-data/:hostName/:serviceName - Detailed service data
  
  📊 METRICS:
  - GET /metrics/:clientId - Fetch metrics for a period
  
  📊 AVAILABILITY:
  - GET /availability/:clientId - Availability statistics
  
  📊 EVENTS:
  - GET /events/:hostName - Open events
  - GET /host-events/:hostName - Detailed events
  - GET /events-period/:hostName - Events over a period
  
  📧 NOTIFICATIONS:
  - GET /notifications/:hostName - Notifications for a host

  MODULAR STRUCTURE:
  - utils.js: Shared utility functions
  - mapping.js: Mapping routes
  - hosts.js: Host routes
  - services.js: Service routes
  - availability.js: Availability routes
  - metrics.js: Metrics routes
  - events.js: Event routes
  - notifications.js: Notification routes
  - index.js: Entry point that consolidates all modules
*/
