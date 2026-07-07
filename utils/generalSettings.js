export const GENERAL_SETTINGS_SECTION = "general";

export const GENERAL_SETTING_KEYS = {
  defaultLocale: "app_default_locale",
  timezone: "app_timezone",
  dateFormat: "app_date_format",
  organizationName: "app_organization_name",
  defaultTheme: "app_default_theme",
  defaultPageSize: "app_default_page_size",
  supportEmail: "app_support_email",
  supportPhone: "app_support_phone",
  organizationAddress: "app_organization_address",
  organizationWebsite: "app_organization_website",
  organizationEmployeeRange: "app_organization_employee_range",
  knowledgeBaseUrl: "app_knowledge_base_url",
};

export const ALLOWED_LOCALES = ["fr", "en", "de", "it", "es"];
export const ALLOWED_DATE_FORMATS = ["dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd"];
export const ALLOWED_THEMES = ["light", "dark", "system"];
export const ALLOWED_PAGE_SIZES = ["25", "50", "100"];

export const ALLOWED_EMPLOYEE_RANGES = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001+",
];

export const DEFAULT_GENERAL_SETTINGS = {
  [GENERAL_SETTING_KEYS.defaultLocale]: "fr",
  [GENERAL_SETTING_KEYS.timezone]: "Europe/Paris",
  [GENERAL_SETTING_KEYS.dateFormat]: "dd/mm/yyyy",
  [GENERAL_SETTING_KEYS.organizationName]: "Veritas",
  [GENERAL_SETTING_KEYS.defaultTheme]: "light",
  [GENERAL_SETTING_KEYS.defaultPageSize]: "50",
  [GENERAL_SETTING_KEYS.supportEmail]: "",
  [GENERAL_SETTING_KEYS.supportPhone]: "",
  [GENERAL_SETTING_KEYS.organizationAddress]: "",
  [GENERAL_SETTING_KEYS.organizationWebsite]: "",
  [GENERAL_SETTING_KEYS.organizationEmployeeRange]: "",
  [GENERAL_SETTING_KEYS.knowledgeBaseUrl]: "",
};

export const GENERAL_SETTINGS_LABELS = {
  [GENERAL_SETTING_KEYS.defaultLocale]: "Langue par défaut",
  [GENERAL_SETTING_KEYS.timezone]: "Fuseau horaire",
  [GENERAL_SETTING_KEYS.dateFormat]: "Format de date",
  [GENERAL_SETTING_KEYS.organizationName]: "Nom de l'organisation",
  [GENERAL_SETTING_KEYS.defaultTheme]: "Thème par défaut",
  [GENERAL_SETTING_KEYS.defaultPageSize]: "Éléments par page (défaut)",
  [GENERAL_SETTING_KEYS.supportEmail]: "E-mail de contact support",
  [GENERAL_SETTING_KEYS.supportPhone]: "Téléphone support",
  [GENERAL_SETTING_KEYS.organizationAddress]: "Adresse de l'organisation",
  [GENERAL_SETTING_KEYS.organizationWebsite]: "Site web de l'organisation",
  [GENERAL_SETTING_KEYS.organizationEmployeeRange]: "Effectif de l'organisation",
  [GENERAL_SETTING_KEYS.knowledgeBaseUrl]: "URL Knowledge Base",
};

export function normalizeGeneralSettings(input = {}) {
  const out = { ...DEFAULT_GENERAL_SETTINGS };

  if (ALLOWED_LOCALES.includes(input[GENERAL_SETTING_KEYS.defaultLocale])) {
    out[GENERAL_SETTING_KEYS.defaultLocale] = input[GENERAL_SETTING_KEYS.defaultLocale];
  }
  if (typeof input[GENERAL_SETTING_KEYS.timezone] === "string" && input[GENERAL_SETTING_KEYS.timezone].trim()) {
    out[GENERAL_SETTING_KEYS.timezone] = input[GENERAL_SETTING_KEYS.timezone].trim();
  }
  if (ALLOWED_DATE_FORMATS.includes(input[GENERAL_SETTING_KEYS.dateFormat])) {
    out[GENERAL_SETTING_KEYS.dateFormat] = input[GENERAL_SETTING_KEYS.dateFormat];
  }
  if (typeof input[GENERAL_SETTING_KEYS.organizationName] === "string") {
    out[GENERAL_SETTING_KEYS.organizationName] = input[GENERAL_SETTING_KEYS.organizationName].trim().slice(0, 120) || "Veritas";
  }
  if (ALLOWED_THEMES.includes(input[GENERAL_SETTING_KEYS.defaultTheme])) {
    out[GENERAL_SETTING_KEYS.defaultTheme] = input[GENERAL_SETTING_KEYS.defaultTheme];
  }
  if (ALLOWED_PAGE_SIZES.includes(String(input[GENERAL_SETTING_KEYS.defaultPageSize]))) {
    out[GENERAL_SETTING_KEYS.defaultPageSize] = String(input[GENERAL_SETTING_KEYS.defaultPageSize]);
  }
  if (typeof input[GENERAL_SETTING_KEYS.supportEmail] === "string") {
    out[GENERAL_SETTING_KEYS.supportEmail] = input[GENERAL_SETTING_KEYS.supportEmail].trim().slice(0, 200);
  }
  if (typeof input[GENERAL_SETTING_KEYS.supportPhone] === "string") {
    out[GENERAL_SETTING_KEYS.supportPhone] = input[GENERAL_SETTING_KEYS.supportPhone].trim().slice(0, 40);
  }
  if (typeof input[GENERAL_SETTING_KEYS.organizationAddress] === "string") {
    out[GENERAL_SETTING_KEYS.organizationAddress] = input[GENERAL_SETTING_KEYS.organizationAddress].trim().slice(0, 300);
  }
  if (typeof input[GENERAL_SETTING_KEYS.organizationWebsite] === "string") {
    out[GENERAL_SETTING_KEYS.organizationWebsite] = input[GENERAL_SETTING_KEYS.organizationWebsite].trim().slice(0, 200);
  }
  if (typeof input[GENERAL_SETTING_KEYS.knowledgeBaseUrl] === "string") {
    const url = input[GENERAL_SETTING_KEYS.knowledgeBaseUrl].trim().slice(0, 500);
    out[GENERAL_SETTING_KEYS.knowledgeBaseUrl] = /^https?:\/\//i.test(url) ? url : "";
  }
  const employeeRange = input[GENERAL_SETTING_KEYS.organizationEmployeeRange];
  if (employeeRange === "" || employeeRange == null) {
    out[GENERAL_SETTING_KEYS.organizationEmployeeRange] = "";
  } else if (ALLOWED_EMPLOYEE_RANGES.includes(String(employeeRange))) {
    out[GENERAL_SETTING_KEYS.organizationEmployeeRange] = String(employeeRange);
  }

  return out;
}
