// ───────────────────────────────────────────────
// 📦 Route Check MK — Point d'entrée consolidé
// ───────────────────────────────────────────────
// Ce fichier fait office de point d'entrée et réexporte les routes modularisées

import checkMKRouter from './checkmk/index.js';

export default checkMKRouter;

/*
  ROUTES DISPONIBLES:
  
  📍 MAPPING:
  - GET /mapping/:clientId - Récupérer les mappings d'un client
  - GET /mapping/:clientId/stats - Statistiques des mappings
  - POST /mapping - Créer/mettre à jour un mapping
  - DELETE /mapping/:id - Supprimer un mapping
  
  🏠 HOSTS:
  - GET /hosts - Lister tous les hosts disponibles
  - GET /host/:hostName - Récupérer les détails d'un hôte
  - GET /availability-table/:hostName - Tableau de disponibilité d'un hôte
  
  📋 SERVICES:
  - GET /services/:hostName - Récupérer les services d'un hôte
  - GET /service-data/:hostName/:serviceName - Données détaillées d'un service
  
  📊 MÉTRIQUES:
  - GET /metrics/:clientId - Récupérer les métriques pour une période
  
  📊 DISPONIBILITÉ:
  - GET /availability/:clientId - Statistiques de disponibilité
  
  📊 ÉVÉNEMENTS:
  - GET /events/:hostName - Événements ouverts
  - GET /host-events/:hostName - Événements détaillés
  - GET /events-period/:hostName - Événements sur une période
  
  📧 NOTIFICATIONS:
  - GET /notifications/:hostName - Notifications pour un hôte

  STRUCTURE MODULAIRE:
  - utils.js: Fonctions utilitaires partagées
  - mapping.js: Routes de mapping
  - hosts.js: Routes des hôtes
  - services.js: Routes des services
  - availability.js: Routes de disponibilité
  - metrics.js: Routes des métriques
  - events.js: Routes des événements
  - notifications.js: Routes des notifications
  - index.js: Point d'entrée qui consolide tous les modules
*/

