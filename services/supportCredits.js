import { pool } from "../database/db.js";
let packsTableExistsCache = null;
export function isSalesTicket(type, category) {
  const normalizedType = String(type || "").toLowerCase();
  const normalizedCategory = String(category || "");
  return normalizedType === "demande" && (normalizedCategory.startsWith("prestation-") || normalizedCategory.startsWith("installation-"));
}
export function shouldConsumeSupportCredit({
  type,
  category,
  clientId
}) {
  if (!clientId) return false;
  return !isSalesTicket(type, category);
}
export async function resolveClientIdForTicket({
  clientId,
  requesterContactId
}) {
  if (clientId) return Number(clientId);
  if (!requesterContactId) return null;
  const result = await pool.query("SELECT client_id FROM v_b_contacts WHERE id = $1 LIMIT 1", [requesterContactId]);
  const resolved = result.rows[0]?.client_id;
  return resolved === null || resolved === undefined ? null : Number(resolved);
}
async function hasPacksTable() {
  if (packsTableExistsCache !== null) return packsTableExistsCache;
  const result = await pool.query(`SELECT to_regclass('public.v_b_client_support_credit_packs') AS reg`);
  packsTableExistsCache = Boolean(result.rows[0]?.reg);
  return packsTableExistsCache;
}
function packStatus(row) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const validFrom = row?.valid_from ? new Date(row.valid_from) : null;
  const validUntil = row?.valid_until ? new Date(row.valid_until) : null;
  if (validFrom && validFrom > today) return "upcoming";
  if (validUntil && validUntil < today) return "expired";
  if (Number(row?.remaining_amount ?? 0) <= 0) return "depleted";
  return "active";
}
function isPackUsable(row) {
  return packStatus(row) === "active" && Number(row?.remaining_amount ?? 0) > 0;
}
async function syncClientBalance(dbClient, clientId) {
  const hasPacks = await hasPacksTable();
  let balance = 0;
  if (hasPacks) {
    const packsResult = await dbClient.query(`SELECT COALESCE(SUM(remaining_amount), 0)::int AS balance
       FROM v_b_client_support_credit_packs
       WHERE client_id = $1
         AND archived_at IS NULL
         AND remaining_amount > 0
         AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
         AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`, [clientId]);
    balance = Number(packsResult.rows[0]?.balance ?? 0);
  } else {
    const legacy = await dbClient.query("SELECT balance FROM v_b_client_support_credits WHERE client_id = $1", [clientId]);
    balance = Number(legacy.rows[0]?.balance ?? 0);
  }
  await dbClient.query(`INSERT INTO v_b_client_support_credits (client_id, balance, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (client_id) DO UPDATE
       SET balance = EXCLUDED.balance, updated_at = NOW()`, [clientId, balance]);
  return balance;
}
function createInsufficientCreditsError(balance) {
  const err = new Error("Insufficient support credits");
  err.code = "INSUFFICIENT_SUPPORT_CREDITS";
  err.status = 402;
  err.balance = balance;
  return err;
}
async function pickPackForDebit(dbClient, clientId) {
  const hasPacks = await hasPacksTable();
  if (!hasPacks) return null;
  const result = await dbClient.query(`SELECT id, remaining_amount, valid_from, valid_until
     FROM v_b_client_support_credit_packs
     WHERE client_id = $1
       AND archived_at IS NULL
       AND remaining_amount > 0
       AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
     ORDER BY valid_until ASC NULLS LAST, created_at ASC
     FOR UPDATE`, [clientId]);
  return result.rows[0] || null;
}
async function applyCreditDelta(dbClient, clientId, delta, {
  ticketId,
  note,
  userId,
  kind,
  packId = null
}) {
  const balance = await syncClientBalance(dbClient, clientId);
  const newBalance = balance + delta;
  if (newBalance < 0) {
    throw createInsufficientCreditsError(balance);
  }
  const ledgerResult = await dbClient.query(`INSERT INTO v_b_client_support_credit_ledger
       (client_id, delta, balance_after, kind, ticket_id, pack_id, note, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     RETURNING *`, [clientId, delta, newBalance, kind, ticketId || null, packId, note || null, userId || null]);
  await syncClientBalance(dbClient, clientId);
  return {
    balance: newBalance,
    entry: ledgerResult.rows[0]
  };
}
export async function listCreditPacks(clientId) {
  const hasPacks = await hasPacksTable();
  if (!hasPacks) return [];
  const result = await pool.query(`SELECT p.*, u.username, u.email
     FROM v_b_client_support_credit_packs p
     LEFT JOIN v_b_users u ON u.id = p.created_by
     WHERE p.client_id = $1 AND p.archived_at IS NULL
     ORDER BY p.valid_until ASC NULLS LAST, p.created_at DESC`, [clientId]);
  return result.rows.map(row => ({
    ...row,
    status: packStatus(row)
  }));
}
export async function getSupportCreditBalance(clientId) {
  const hasPacks = await hasPacksTable();
  if (!hasPacks) {
    const result = await pool.query("SELECT balance FROM v_b_client_support_credits WHERE client_id = $1", [clientId]);
    return Number(result.rows[0]?.balance ?? 0);
  }
  const result = await pool.query(`SELECT COALESCE(SUM(remaining_amount), 0)::int AS balance
     FROM v_b_client_support_credit_packs
     WHERE client_id = $1
       AND archived_at IS NULL
       AND remaining_amount > 0
       AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`, [clientId]);
  return Number(result.rows[0]?.balance ?? 0);
}
export async function getSupportCreditSummary(clientId) {
  const [balance, packs, ledgerResult] = await Promise.all([getSupportCreditBalance(clientId), listCreditPacks(clientId), pool.query(`SELECT l.id, l.client_id, l.delta, l.balance_after, l.kind, l.ticket_id, l.pack_id, l.note,
              l.created_by, l.created_at,
              u.username, u.email,
              t.ticket_number,
              p.label AS pack_label
       FROM v_b_client_support_credit_ledger l
       LEFT JOIN v_b_users u ON u.id = l.created_by
       LEFT JOIN v_b_tickets t ON t.id = l.ticket_id
       LEFT JOIN v_b_client_support_credit_packs p ON p.id = l.pack_id
       WHERE l.client_id = $1
       ORDER BY l.created_at DESC
       LIMIT 50`, [clientId])]);
  return {
    balance,
    packs,
    ledger: ledgerResult.rows
  };
}
export async function createCreditPack(clientId, {
  amount,
  validFrom = null,
  validUntil = null,
  label = null,
  note,
  userId
} = {}) {
  const parsedAmount = Number(amount);
  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    const err = new Error("The number of tickets must be a positive integer");
    err.status = 400;
    throw err;
  }
  const hasPacks = await hasPacksTable();
  if (!hasPacks) {
    const err = new Error("Ticket packs are not installed yet (migration required)");
    err.status = 503;
    throw err;
  }
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const packResult = await dbClient.query(`INSERT INTO v_b_client_support_credit_packs
         (client_id, label, initial_amount, remaining_amount, valid_from, valid_until, note, created_by, created_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, NOW())
       RETURNING *`, [clientId, label || `Pack of ${parsedAmount} ticket(s)`, parsedAmount, validFrom || null, validUntil || null, note || null, userId || null]);
    const pack = packResult.rows[0];
    const balance = await syncClientBalance(dbClient, clientId);
    const ledgerResult = await dbClient.query(`INSERT INTO v_b_client_support_credit_ledger
         (client_id, delta, balance_after, kind, ticket_id, pack_id, note, created_by, created_at)
       VALUES ($1, $2, $3, 'credit', NULL, $4, $5, $6, NOW())
       RETURNING *`, [clientId, parsedAmount, balance, pack.id, note || `Pack credit: ${pack.label}`, userId || null]);
    await dbClient.query("COMMIT");
    return {
      pack: {
        ...pack,
        status: packStatus(pack)
      },
      balance,
      entry: ledgerResult.rows[0]
    };
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }
}
export async function creditClientSupportTickets(clientId, options = {}) {
  return createCreditPack(clientId, options);
}
export async function listAllSupportCreditPacks() {
  const hasPacks = await hasPacksTable();
  if (!hasPacks) return [];
  const result = await pool.query(`SELECT p.id, p.client_id, p.label, p.initial_amount, p.remaining_amount,
            p.valid_from, p.valid_until, p.note, p.created_by, p.created_at, p.archived_at,
            c.name AS client_name,
            c.client_number,
            u.username, u.email
     FROM v_b_client_support_credit_packs p
     JOIN v_b_clients c ON c.id = p.client_id
     LEFT JOIN v_b_users u ON u.id = p.created_by
     WHERE p.archived_at IS NULL
     ORDER BY c.name ASC, p.valid_until ASC NULLS LAST, p.created_at DESC`);
  return result.rows.map(row => ({
    ...row,
    status: packStatus(row)
  }));
}
export async function updateCreditPack(clientId, packId, updates = {}, userId = null) {
  const hasPacks = await hasPacksTable();
  if (!hasPacks) {
    const err = new Error("Ticket packs are not installed yet (migration required)");
    err.status = 503;
    throw err;
  }
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const existingResult = await dbClient.query(`SELECT *
       FROM v_b_client_support_credit_packs
       WHERE id = $1 AND client_id = $2 AND archived_at IS NULL
       FOR UPDATE`, [packId, clientId]);
    const existing = existingResult.rows[0];
    if (!existing) {
      const err = new Error("Pack not found");
      err.status = 404;
      throw err;
    }
    const consumed = Number(existing.initial_amount) - Number(existing.remaining_amount);
    const nextLabel = updates.label !== undefined ? String(updates.label || "").trim() || existing.label : existing.label;
    const nextNote = updates.note !== undefined ? String(updates.note || "").trim() || null : existing.note;
    const nextValidFrom = updates.validFrom !== undefined ? updates.validFrom || null : updates.valid_from !== undefined ? updates.valid_from || null : existing.valid_from;
    const nextValidUntil = updates.validUntil !== undefined ? updates.validUntil || null : updates.valid_until !== undefined ? updates.valid_until || null : existing.valid_until;
    let nextInitial = updates.initial_amount !== undefined ? Number(updates.initial_amount) : Number(existing.initial_amount);
    let nextRemaining = updates.remaining_amount !== undefined ? Number(updates.remaining_amount) : Number(existing.remaining_amount);
    if (!Number.isInteger(nextInitial) || nextInitial <= 0) {
      const err = new Error("The initial number of tickets must be a positive integer");
      err.status = 400;
      throw err;
    }
    if (!Number.isInteger(nextRemaining) || nextRemaining < 0) {
      const err = new Error("The remaining balance must be a positive integer or zero");
      err.status = 400;
      throw err;
    }
    if (nextRemaining > nextInitial) {
      const err = new Error("The remaining balance cannot exceed the initial amount");
      err.status = 400;
      throw err;
    }
    if (nextInitial < consumed) {
      const err = new Error(`The initial amount cannot be lower than the number of tickets already used (${consumed})`);
      err.status = 400;
      throw err;
    }
    const updateResult = await dbClient.query(`UPDATE v_b_client_support_credit_packs
       SET label = $1,
           initial_amount = $2,
           remaining_amount = $3,
           valid_from = $4,
           valid_until = $5,
           note = $6
       WHERE id = $7
       RETURNING *`, [nextLabel, nextInitial, nextRemaining, nextValidFrom, nextValidUntil, nextNote, packId]);
    const balance = await syncClientBalance(dbClient, clientId);
    await dbClient.query("COMMIT");
    const pack = updateResult.rows[0];
    return {
      pack: {
        ...pack,
        status: packStatus(pack)
      },
      balance
    };
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }
}
export async function archiveCreditPack(clientId, packId, userId = null) {
  const hasPacks = await hasPacksTable();
  if (!hasPacks) {
    const err = new Error("Ticket packs are not installed yet (migration required)");
    err.status = 503;
    throw err;
  }
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const existingResult = await dbClient.query(`SELECT *
       FROM v_b_client_support_credit_packs
       WHERE id = $1 AND client_id = $2 AND archived_at IS NULL
       FOR UPDATE`, [packId, clientId]);
    const existing = existingResult.rows[0];
    if (!existing) {
      const err = new Error("Pack not found");
      err.status = 404;
      throw err;
    }
    await dbClient.query(`UPDATE v_b_client_support_credit_packs
       SET archived_at = NOW()
       WHERE id = $1`, [packId]);
    const balance = await syncClientBalance(dbClient, clientId);
    if (Number(existing.remaining_amount) > 0) {
      await dbClient.query(`INSERT INTO v_b_client_support_credit_ledger
           (client_id, delta, balance_after, kind, ticket_id, pack_id, note, created_by, created_at)
         VALUES ($1, $2, $3, 'adjustment', NULL, $4, $5, $6, NOW())`, [clientId, -Number(existing.remaining_amount), balance, packId, `Pack archived: ${existing.label || "Pack"}`, userId]);
    }
    await dbClient.query("COMMIT");
    return {
      success: true,
      balance
    };
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }
}
export function normalizeSupportCreditDebits(input, {
  consumeSupportCredit = false
} = {}) {
  if (Array.isArray(input) && input.length > 0) {
    return input.map(row => ({
      packId: row?.packId || row?.pack_id || null,
      amount: Math.max(0, Math.floor(Number(row?.amount) || 0))
    })).filter(row => row.amount > 0);
  }
  if (consumeSupportCredit) {
    return [{
      packId: null,
      amount: 1
    }];
  }
  return [];
}
async function listTicketDebitEntries(ticketId, dbClient = pool) {
  const result = await dbClient.query(`SELECT l.*, p.label AS pack_label, t.ticket_number
     FROM v_b_client_support_credit_ledger l
     LEFT JOIN v_b_client_support_credit_packs p ON p.id = l.pack_id
     LEFT JOIN v_b_tickets t ON t.id = l.ticket_id
     WHERE l.ticket_id = $1 AND l.kind = 'debit'
     ORDER BY l.created_at ASC`, [ticketId]);
  return result.rows || [];
}
export async function isTicketCreditDebited(ticketId) {
  const result = await pool.query(`SELECT id
     FROM v_b_client_support_credit_ledger
     WHERE ticket_id = $1 AND kind = 'debit'
     LIMIT 1`, [ticketId]);
  return result.rows.length > 0;
}
export async function isTicketCreditRefunded(ticketId) {
  const result = await pool.query(`SELECT id
     FROM v_b_client_support_credit_ledger
     WHERE ticket_id = $1 AND kind = 'refund'
     LIMIT 1`, [ticketId]);
  return result.rows.length > 0;
}
export async function getTicketCreditStatus(ticket) {
  if (!ticket?.id) return null;
  const clientId = ticket.client_id ? Number(ticket.client_id) : null;
  const eligible = shouldConsumeSupportCredit({
    type: ticket.type,
    category: ticket.category,
    clientId
  });
  if (!eligible || !clientId) {
    return {
      eligible: false,
      consumed: false,
      refunded: false,
      balance: 0,
      packs: []
    };
  }
  const [balance, packs, consumed, refunded, debitEntries] = await Promise.all([getSupportCreditBalance(clientId), listCreditPacks(clientId), isTicketCreditDebited(ticket.id), isTicketCreditRefunded(ticket.id), listTicketDebitEntries(ticket.id)]);
  const totalDebited = debitEntries.reduce((sum, row) => sum + Math.abs(Number(row?.delta) || 0), 0);
  return {
    eligible: true,
    consumed: consumed && !refunded,
    refunded,
    balance,
    packs: packs.filter(pack => isPackUsable(pack) || pack.status === "upcoming"),
    debitEntries,
    debitEntry: debitEntries[debitEntries.length - 1] || null,
    totalDebited
  };
}
export async function consumeCreditsForTicket(ticketId, userId, debits = []) {
  const normalizedDebits = normalizeSupportCreditDebits(debits);
  if (normalizedDebits.length === 0) {
    return {
      skipped: true,
      reason: "no_debits"
    };
  }
  const ticketResult = await pool.query("SELECT id, client_id, type, category, ticket_number FROM v_b_tickets WHERE id = $1", [ticketId]);
  const ticket = ticketResult.rows[0];
  if (!ticket) {
    const err = new Error("Ticket not found");
    err.status = 404;
    throw err;
  }
  const clientId = ticket.client_id ? Number(ticket.client_id) : null;
  if (!shouldConsumeSupportCredit({
    type: ticket.type,
    category: ticket.category,
    clientId
  })) {
    return {
      skipped: true,
      reason: "not_eligible"
    };
  }
  if (await isTicketCreditDebited(ticketId)) {
    const refunded = await isTicketCreditRefunded(ticketId);
    if (!refunded) {
      return {
        skipped: true,
        reason: "already_debited"
      };
    }
  }
  const hasPacks = await hasPacksTable();
  const dbClient = await pool.connect();
  const noteBase = ticket.ticket_number ? `Ticket #${ticket.ticket_number} resolution` : "Support ticket resolution";
  try {
    await dbClient.query("BEGIN");
    const applied = [];
    for (const debit of normalizedDebits) {
      const amount = Number(debit.amount) || 0;
      if (amount <= 0) continue;
      if (hasPacks && debit.packId) {
        const packResult = await dbClient.query(`UPDATE v_b_client_support_credit_packs
           SET remaining_amount = remaining_amount - $2
           WHERE id = $1
             AND client_id = $3
             AND archived_at IS NULL
             AND remaining_amount >= $2
             AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
             AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
           RETURNING id, label`, [debit.packId, amount, clientId]);
        if (!packResult.rows[0]) {
          const balance = await syncClientBalance(dbClient, clientId);
          throw createInsufficientCreditsError(balance);
        }
        const packLabel = packResult.rows[0].label;
        const result = await applyCreditDelta(dbClient, clientId, -amount, {
          ticketId,
          note: packLabel ? `${noteBase} · ${packLabel}` : noteBase,
          userId,
          kind: "debit",
          packId: debit.packId
        });
        applied.push({
          packId: debit.packId,
          amount,
          balance: result.balance,
          entry: result.entry
        });
        continue;
      }
      if (hasPacks && !debit.packId) {
        let remainingToDebit = amount;
        while (remainingToDebit > 0) {
          const pack = await pickPackForDebit(dbClient, clientId);
          if (!pack) {
            const balance = await syncClientBalance(dbClient, clientId);
            throw createInsufficientCreditsError(balance);
          }
          const packDebit = Math.min(remainingToDebit, Number(pack.remaining_amount) || 0);
          if (packDebit <= 0) break;
          await dbClient.query(`UPDATE v_b_client_support_credit_packs
             SET remaining_amount = remaining_amount - $2
             WHERE id = $1`, [pack.id, packDebit]);
          const result = await applyCreditDelta(dbClient, clientId, -packDebit, {
            ticketId,
            note: noteBase,
            userId,
            kind: "debit",
            packId: pack.id
          });
          applied.push({
            packId: pack.id,
            amount: packDebit,
            balance: result.balance,
            entry: result.entry
          });
          remainingToDebit -= packDebit;
        }
        if (remainingToDebit > 0) {
          const balance = await syncClientBalance(dbClient, clientId);
          throw createInsufficientCreditsError(balance);
        }
        continue;
      }
      const result = await applyCreditDelta(dbClient, clientId, -amount, {
        ticketId,
        note: noteBase,
        userId,
        kind: "debit",
        packId: null
      });
      applied.push({
        packId: null,
        amount,
        balance: result.balance,
        entry: result.entry
      });
    }
    await dbClient.query("COMMIT");
    const last = applied[applied.length - 1];
    return {
      skipped: false,
      balance: last?.balance ?? (await getSupportCreditBalance(clientId)),
      entries: applied.map(row => row.entry).filter(Boolean),
      debits: applied
    };
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }
}
export async function consumeCreditForTicketResolution(ticketId, userId) {
  return consumeCreditsForTicket(ticketId, userId, [{
    packId: null,
    amount: 1
  }]);
}
export async function refundCreditForTicket(ticketId, userId) {
  const debitEntries = await listTicketDebitEntries(ticketId);
  if (debitEntries.length === 0) {
    return {
      skipped: true,
      reason: "no_debit"
    };
  }
  if (await isTicketCreditRefunded(ticketId)) {
    return {
      skipped: true,
      reason: "already_refunded"
    };
  }
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const results = [];
    for (const debitEntry of debitEntries) {
      const amount = Math.abs(Number(debitEntry.delta) || 0);
      if (amount <= 0) continue;
      if (debitEntry.pack_id) {
        await dbClient.query(`UPDATE v_b_client_support_credit_packs
           SET remaining_amount = LEAST(initial_amount, remaining_amount + $2)
           WHERE id = $1`, [debitEntry.pack_id, amount]);
      }
      const result = await applyCreditDelta(dbClient, debitEntry.client_id, amount, {
        ticketId,
        note: debitEntry.ticket_number ? `Refund for ticket #${debitEntry.ticket_number}` : debitEntry.pack_label ? `Pack refund: ${debitEntry.pack_label}` : "Ticket credit refund",
        userId,
        kind: "refund",
        packId: debitEntry.pack_id
      });
      results.push(result);
    }
    await dbClient.query("COMMIT");
    const last = results[results.length - 1];
    return {
      skipped: false,
      balance: last?.balance,
      entries: results.map(row => row.entry).filter(Boolean)
    };
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }
}
export async function handleTicketStatusCreditChange({
  ticketId,
  oldStatus,
  newStatus,
  userId,
  consumeSupportCredit = false,
  supportCreditDebits = null,
  refundSupportCredit = false
}) {
  const normalizedOld = oldStatus === "open" ? "new" : oldStatus;
  const normalizedNew = newStatus === "open" ? "new" : newStatus;
  const results = {};
  const debits = normalizeSupportCreditDebits(supportCreditDebits, {
    consumeSupportCredit
  });
  if (debits.length > 0 && (normalizedNew === "resolved" || normalizedNew === "closed") && normalizedOld !== "resolved" && normalizedOld !== "closed") {
    results.consume = await consumeCreditsForTicket(ticketId, userId, debits);
  }
  if (refundSupportCredit && (normalizedOld === "resolved" || normalizedOld === "closed") && normalizedNew !== "resolved" && normalizedNew !== "closed") {
    results.refund = await refundCreditForTicket(ticketId, userId);
  }
  return results;
}
