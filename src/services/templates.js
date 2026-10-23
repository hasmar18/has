// Výchozí e-mailové šablony. Předmět i text lze upravit v administraci (E-maily → Šablony).
// V textu lze použít proměnné ve tvaru {{nazev}}. Prázdný řádek odděluje odstavce.
export const TEMPLATE_VARS = {
  client_name: 'Jméno klientky',
  service_name: 'Název služby',
  date: 'Datum (např. pátek 23. října 2026)',
  time: 'Čas začátku (např. 14:30)',
  price: 'Cena (např. 450 Kč)',
  address: 'Adresa studia',
  phone: 'Telefon studia',
  studio_name: 'Název studia',
  manage_url: 'Odkaz pro správu rezervace',
  cancel_policy: 'Storno podmínky',
  code: 'Ověřovací kód',
  hold_minutes: 'Počet minut, po které je termín držen',
  verify_url: 'Odkaz pro ověření e-mailu',
  reset_url: 'Odkaz pro obnovení hesla',
  details: 'Podrobnosti (chyby, zpráva klientky)',
};

export const DEFAULT_TEMPLATES = {
  booking_verify: {
    label: 'Ověření rezervace (kód)',
    subject: 'Potvrďte rezervaci – kód {{code}}',
    body: 'Dobrý den, {{client_name}},\n\nrezervaci služby {{service_name}} na {{date}} v {{time}} dokončíte zadáním kódu na webu:\n\n{{code}}\n\nTermín pro vás držíme {{hold_minutes}} minut. Pokud jste rezervaci nevytvářeli vy, tento e-mail prosím ignorujte.',
  },
  booking_confirmed: {
    label: 'Potvrzení rezervace',
    subject: 'Rezervace potvrzena – {{date}} v {{time}}',
    body: 'Dobrý den, {{client_name}},\n\nvaše rezervace je potvrzena.\n\nSlužba: {{service_name}}\nTermín: {{date}} v {{time}}\nCena: {{price}}\nAdresa: {{address}}\n\n{{cancel_policy}}\n\nRezervaci můžete zobrazit, zrušit nebo požádat o změnu termínu pomocí tlačítka níže. Těšíme se na vás!',
  },
  booking_rescheduled: {
    label: 'Potvrzení změny termínu',
    subject: 'Změna termínu rezervace – {{date}} v {{time}}',
    body: 'Dobrý den, {{client_name}},\n\ntermín vaší rezervace byl změněn.\n\nSlužba: {{service_name}}\nNový termín: {{date}} v {{time}}\nAdresa: {{address}}\n\nPokud vám nový termín nevyhovuje, ozvěte se nám prosím na {{phone}}.',
  },
  booking_cancelled: {
    label: 'Potvrzení zrušení rezervace',
    subject: 'Rezervace byla zrušena',
    body: 'Dobrý den, {{client_name}},\n\nvaše rezervace služby {{service_name}} na {{date}} v {{time}} byla zrušena.\n\nNový termín si můžete kdykoli vybrat na našem webu. V případě dotazů nám zavolejte na {{phone}}.',
  },
  booking_reminder: {
    label: 'Připomenutí návštěvy',
    subject: 'Připomínka: {{date}} v {{time}} – {{studio_name}}',
    body: 'Dobrý den, {{client_name}},\n\npřipomínáme vaši návštěvu.\n\nSlužba: {{service_name}}\nTermín: {{date}} v {{time}}\nAdresa: {{address}}\n\nPokud se nemůžete dostavit, zrušte prosím rezervaci co nejdříve pomocí tlačítka níže.',
  },
  account_verify: {
    label: 'Ověření e-mailu (registrace)',
    subject: 'Ověřte svůj e-mail – {{studio_name}}',
    body: 'Dobrý den, {{client_name}},\n\nděkujeme za registraci. Svou e-mailovou adresu ověříte kliknutím na tlačítko níže. Odkaz platí 24 hodin.\n\nPokud jste se neregistrovali vy, e-mail ignorujte.',
  },
  account_exists: {
    label: 'Účet již existuje',
    subject: 'Registrace – účet již existuje',
    body: 'Dobrý den,\n\nněkdo se pokusil zaregistrovat tuto e-mailovou adresu, ale účet již existuje. Pokud jste to byli vy a zapomněli jste heslo, použijte na webu „Zapomenuté heslo“. Jinak můžete tento e-mail ignorovat.',
  },
  password_reset: {
    label: 'Obnovení hesla',
    subject: 'Obnovení hesla – {{studio_name}}',
    body: 'Dobrý den,\n\nobdrželi jsme žádost o obnovení hesla. Nové heslo nastavíte tlačítkem níže. Odkaz platí 1 hodinu.\n\nPokud jste o obnovení nežádali, e-mail ignorujte – vaše heslo zůstává beze změny.',
  },
  admin_new_booking: {
    label: 'Upozornění pro majitelku: nová rezervace',
    subject: 'Nová rezervace – {{client_name}}, {{date}} v {{time}}',
    body: 'Nová online rezervace.\n\nKlientka: {{client_name}}\nTelefon: {{details}}\nSlužba: {{service_name}}\nTermín: {{date}} v {{time}}',
  },
  admin_reschedule_request: {
    label: 'Upozornění pro majitelku: žádost o změnu termínu',
    subject: 'Žádost o změnu termínu – {{client_name}}',
    body: 'Klientka {{client_name}} žádá o změnu termínu rezervace ({{service_name}}, {{date}} v {{time}}).\n\nZpráva:\n{{details}}',
  },
  admin_sync_error: {
    label: 'Upozornění pro majitelku: chyba synchronizace kalendáře',
    subject: 'Pozor: synchronizace kalendáře nefunguje',
    body: 'Synchronizace kalendáře selhala a online rezervace mohou být dočasně vypnuté, aby nedošlo k dvojí rezervaci.\n\n{{details}}\n\nPřihlaste se do administrace → Nastavení → Kalendář a propojení znovu autorizujte nebo zkontrolujte.',
  },
};
