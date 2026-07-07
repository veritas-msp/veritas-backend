/** Vues intégrées TicketPage — miroir de veritas-frontend/src/utils/ticketViewConstants.js */

export const BUILTIN_TICKET_VIEW_IDS = {
  NEW: "__builtin_new__",
  IN_PROGRESS: "__builtin_in_progress__",
  PENDING: "__builtin_pending__",
  OPEN: "__builtin_open__",
  ALL: "__builtin_all__",
};

export const BUILTIN_TICKET_VIEWS = [
  {
    id: BUILTIN_TICKET_VIEW_IDS.NEW,
    rules: {
      matchMode: "all",
      viewMode: "active",
      criteria: [{ field: "status", operator: "equals", value: "new" }],
    },
  },
  {
    id: BUILTIN_TICKET_VIEW_IDS.IN_PROGRESS,
    rules: {
      matchMode: "all",
      viewMode: "active",
      criteria: [{ field: "status", operator: "equals", value: "in_progress" }],
    },
  },
  {
    id: BUILTIN_TICKET_VIEW_IDS.PENDING,
    rules: {
      matchMode: "all",
      viewMode: "active",
      criteria: [{ field: "status", operator: "equals", value: "pending" }],
    },
  },
  {
    id: BUILTIN_TICKET_VIEW_IDS.OPEN,
    rules: {
      matchMode: "all",
      viewMode: "active",
      criteria: [{ field: "status", operator: "equals", value: "open" }],
    },
  },
  {
    id: BUILTIN_TICKET_VIEW_IDS.ALL,
    rules: {
      matchMode: "all",
      viewMode: "active",
      criteria: [],
    },
  },
];

export function resolveBuiltinViewRules(viewId) {
  const found = BUILTIN_TICKET_VIEWS.find((view) => String(view.id) === String(viewId));
  return found?.rules || null;
}
