import express from 'express';
import verifyJWT from '../../middleware/auth.js';
import { resolveMailinblackCredentials, getGlobalMailinblackConfigStatus } from '../../utils/mailinblackCredentials.js';
import { mailinblackProtectCheck, mailinblackListCustomers, mailinblackGetCustomer, mailinblackBuildDashboard, formatMailinblackSyncPayload } from '../../utils/mailinblackApi.js';
const router = express.Router();
router.use(verifyJWT);
function buildInlineCredentials(req) {
  const bodyUrl = (req.body?.MAILINBLACK_API_URL || req.body?.apiUrl || '').trim();
  const bodyKey = (req.body?.MAILINBLACK_API_KEY || req.body?.apiKey || req.body?.authKey || '').trim();
  const bodyClientId = (req.body?.MAILINBLACK_CLIENT_ID || req.body?.authClientId || '').trim();
  if (bodyUrl && bodyKey) {
    return {
      apiUrl: bodyUrl,
      authKey: bodyKey,
      apiKey: bodyKey,
      authClientId: bodyClientId || null,
      source: 'inline'
    };
  }
  return null;
}
async function getCredentialsFromRequest(req) {
  const inline = buildInlineCredentials(req);
  if (inline) return inline;
  const clientId = req.query.clientId || req.body?.clientId || null;
  const mailinblackTenantId = req.query.mailinblackTenantId || req.body?.mailinblackTenantId || null;
  return resolveMailinblackCredentials({
    clientId,
    mailinblackTenantId
  });
}
router.get('/config', async (_req, res) => {
  try {
    const status = await getGlobalMailinblackConfigStatus();
    res.json({
      success: true,
      ...status
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
router.post('/test', async (req, res) => {
  try {
    const credentials = await getCredentialsFromRequest(req);
    const checkResult = await mailinblackProtectCheck(credentials.apiUrl, credentials);
    let customers = [];
    try {
      customers = await mailinblackListCustomers(credentials.apiUrl, credentials);
    } catch {
      customers = [];
    }
    const authKey = credentials.authKey || credentials.apiKey;
    res.json({
      success: true,
      message: 'Successfully connected to Mailinblack Protect API',
      tenant: {
        apiUrl: credentials.apiUrl,
        authClientId: checkResult.session?.clientId || credentials.authClientId || null,
        authKeyPreview: authKey ? `${authKey.substring(0, 8)}…` : null,
        customersCount: customers.length,
        customers: customers.slice(0, 50).map(customer => ({
          id: customer.id,
          name: customer.name,
          domain: customer.domain,
          usersCount: customer.usersCount,
          status: customer.status
        })),
        check: checkResult,
        testedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    let errorMessage = 'Mailinblack API connection error';
    if (err.status === 401 || /unauthorized|invalid.*key|token/i.test(err.message)) {
      errorMessage = 'Invalid or expired API key';
    } else if (err.status === 403 || /forbidden/i.test(err.message)) {
      errorMessage = 'Access denied — check API key permissions';
    } else if (err.message) {
      errorMessage = err.message;
    }
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: err.body || null
    });
  }
});
router.get('/customers', async (req, res) => {
  try {
    const credentials = await getCredentialsFromRequest(req);
    const customers = await mailinblackListCustomers(credentials.apiUrl, credentials);
    res.json({
      success: true,
      customers,
      total: customers.length
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Error retrieving Mailinblack clients'
    });
  }
});
router.get('/dashboard/:customerId', async (req, res) => {
  try {
    const {
      customerId
    } = req.params;
    const credentials = await getCredentialsFromRequest(req);
    const dashboard = await mailinblackBuildDashboard(credentials.apiUrl, credentials, customerId);
    res.json({
      success: true,
      dashboard
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Error loading Mailinblack dashboard'
    });
  }
});
router.post('/sync/:customerId', async (req, res) => {
  try {
    const {
      customerId
    } = req.params;
    const credentials = await getCredentialsFromRequest(req);
    const [customer, dashboard] = await Promise.all([mailinblackGetCustomer(credentials.apiUrl, credentials, customerId), mailinblackBuildDashboard(credentials.apiUrl, credentials, customerId).catch(() => null)]);
    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Mailinblack client not found'
      });
    }
    const mappingMode = credentials.source === 'dedicated' ? 'dedicated' : 'reseller';
    const payload = formatMailinblackSyncPayload(customer, mappingMode, credentials.mailinblackTenantId, {
      dashboard
    });
    res.json({
      success: true,
      data: payload,
      customer,
      dashboard
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Error synchronizing Mailinblack'
    });
  }
});
export default router;
