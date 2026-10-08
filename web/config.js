// Public settings. Nothing in this file is secret: the publishable key only allows what the
// database's row-level security allows (reading PUBLISHED questions). Never put a "secret" or
// service_role key, a Gemini key or any password here. See docs/SETUP-GUIDE.md, "Connect the website".
window.QB_CONFIG = {
  supabaseUrl: 'https://vlrzpkozdlduwuizkdnz.supabase.co',              // e.g. https://abcdefghijkl.supabase.co
  supabasePublishableKey: 'sb_publishable_iMqj3WRxAu64SHOFbgDssA_DQZP3oAT',   // e.g. sb_publishable_...   (Supabase -> Project Settings -> API Keys)
  siteName: 'Question Bank',
  copyright: 'AyanP_Chem',      // shown in the footer as "© <year> <copyright>"
};
