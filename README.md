# HASNAILS – web a rezervační systém nehtového studia

Kompletní web + online rezervace + administrace + synchronizace kalendáře (Google / Microsoft) + e-maily (Brevo).
Node 22, PostgreSQL, **jen dvě závislosti** (`pg`, `zod`), bez build kroku. Vše v češtině.

> **Stav a poctivé upozornění** najdete v kapitole [Co je ověřeno a co ne](#co-je-ověřeno-a-co-ne). Před spuštěním pro zákaznice projděte [Kontrolní seznam spuštění](#kontrolní-seznam-spuštění).

## Obsah
1. [Co systém umí](#co-systém-umí) · 2. [Architektura](#architektura) · 3. [Nasazení na Render (krok za krokem)](#nasazení-na-render) · 4. [Brevo (e-maily)](#brevo-e-maily) · 5. [Google Kalendář](#google-kalendář) · 6. [Outlook / Microsoft 365](#outlook--microsoft-365) · 7. [Apple Kalendář](#apple-kalendář) · 8. [Instagram](#instagram) · 9. [Vlastní doména](#vlastní-doména) · 10. [Lokální vývoj a testy](#lokální-vývoj-a-testy) · 11. [Provoz, zálohy, GDPR](#provoz-zálohy-gdpr) · 12. [Náklady](#náklady) · 13. [Co je ověřeno a co ne](#co-je-ověřeno-a-co-ne) · 14. [Údržba a rozšiřování](#údržba-a-rozšiřování)

## Co systém umí
- **Veřejný web:** úvod, o studiu, služby a ceník, galerie, Instagram (odkaz; příspěvky jen přes oficiální API), informace pro klientky, kontakt s mapou (Navigovat / Zavolat / Rezervovat), obchodní podmínky a GDPR. Mobile-first.
- **Rezervace:** služba → termín (nabízí se jen skutečně volné časy) → údaje → ověření e-mailu kódem (host) nebo okamžité potvrzení (přihlášená klientka s ověřeným e-mailem) → potvrzovací e-mail s odkazem pro správu. Klientce se **nikdy neukazuje důvod nedostupnosti**.
- **Klientský účet:** registrace, ověření e-mailu, přihlášení, obnova hesla, profil, moje rezervace (budoucí/minulé), zrušení v limitu, žádost o změnu termínu, smazání účtu (anonymizace).
- **Administrace (`/admin`):** přehled s kontrolním seznamem, kalendář den/týden/měsíc, ruční rezervace, soukromé blokace, úpravy/zrušení rezervací s kontrolou kolizí (vědomé přepsání), poznámky, filtry, pracovní doba (více úseků = pauzy), dovolená/svátky/mimořádné hodiny, služby a kategorie, galerie (zmenšení fotek v prohlížeči), texty webu včetně storno podmínek, šablony e-mailů a log odeslání, nastavení (krok, rezerva, předstih, max. dopředu, storno lhůta, upomínky), propojení kalendáře, Instagram token, protokol změn.
- **Kalendář:** obousměrně (viz níže). Osobní události = blokace termínů; rezervace klientek se zapisují do vybraného kalendáře.
- **E-maily přes Brevo API:** ověření, potvrzení, změna, zrušení, upomínka (např. 24 h předem, konfigurovatelné), obnova hesla, upozornění správci (nová rezervace, žádost o změnu, výpadek synchronizace). Fronta s opakováním, deduplikace, log, Brevo webhook (doručeno/odraženo).

## Architektura
```
prohlížeč ── HTTPS ──► Node (src/server.js, vlastní router, statické soubory z /public)
                         ├─ PostgreSQL (rezervace, nastavení, fronta úloh, e-mail log, tokeny šifrované AES-256-GCM)
                         ├─ worker na pozadí (ve stejném procesu): e-maily, upomínky, synchronizace kalendářů, úklid
                         └─ ven: Brevo API, Google Calendar API, Microsoft Graph, Instagram API
```
**Proč nelze dvě klientky rezervovat stejný čas:** nejde o kontrolu v aplikaci, ale o omezení v databázi – `EXCLUDE USING gist` nad časovým rozsahem aktivních rezervací + globální advisory zámek při zápisu. Souběžné požadavky tedy skončí maximálně jedním úspěchem i při chybě v aplikaci.

**Dostupnost** = pracovní doba − výjimky − soukromé blokace − rezervace (včetně čekajících) − rezerva mezi klientkami − externí události z kalendářů − minimální předstih. Pokud nelze spolehlivě znát obsazenost kalendáře (výpadek/zastaralá data), online rezervace se **bezpečně pozastaví** (lze vypnout volbou `fail_closed`, nedoporučeno) a správce dostane jeden e-mail. Těsně před přijetím rezervace se provede okamžitá synchronizace (nejvýše 20 s stará data).

**Kalendář bez smyček a duplicit:** události vytvořené systémem mají deterministické ID + značku, takže se při zpětném čtení nikdy nepovažují za osobní blokaci; osobní události se nikdy nestanou rezervací ani nevyvolají e-mail; každá událost se v databázi páruje s rezervací (verze), opakované zpracování je idempotentní. Smazání/přesun události rezervace v kalendáři se **nepromítne automaticky** (rezervace klientky platí dál), ale zobrazí se jako rozdíl s tlačítkem „Znovu zapsat do kalendáře“.

Složky: `src/` (server, `services/`, `calendar/`, `routes/`), `migrations/` (SQL), `public/` (frontend bez inline skriptů – platí přísné CSP), `test/`.

## Nasazení na Render
Předpoklady: účet na GitHubu (repozitář `hasmar18/has`) a na [render.com](https://render.com).

1. **Render → New → Blueprint** → vyberte repozitář `hasmar18/has` (načte `render.yaml`: webová služba + PostgreSQL). Región Frankfurt.
2. Při vytváření vyplňte proměnné označené `sync: false`:
   | Proměnná | Význam |
   |---|---|
   | `BASE_URL` | veřejná adresa **s https**, bez lomítka (nejdřív `https://<název>.onrender.com`, po nastavení domény ji změňte) |
   | `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` | první administrátor (min. 10 znaků). Po prvním přihlášení heslo změníte; poté proměnnou `ADMIN_INITIAL_PASSWORD` smažte |
   | `BREVO_API_KEY`, `MAIL_FROM_EMAIL`, `MAIL_REPLY_TO` | viz Brevo |
   | `GOOGLE_*`, `MS_*` | volitelné, viz kalendáře |
   `ENCRYPTION_KEY` a `BREVO_WEBHOOK_SECRET` se vygenerují samy. **`ENCRYPTION_KEY` po spuštění nikdy neměňte ani nemažte** – tokeny propojených kalendářů by přestaly jít dešifrovat (museli byste kalendář propojit znovu).
3. Počkejte na první nasazení; migrace databáze i založení administrátora proběhnou automaticky při startu. Kontrola: `https://…/healthz` vrací `{"ok":true}`.
4. Otevřete `/admin`, přihlaste se, nastavte nové heslo.
5. V administraci projděte **Přehled → kontrolní seznam**: služby, pracovní doba, e-maily, kalendář, kontrola nastavení a právních textů, a teprve pak v **Nastavení** zapněte *Online rezervace*.

**Plán:** web na `starter` (≈ 7 USD/měs.), databáze `basic-256mb` (≈ 6 USD/měs.). Bezplatná webová služba usíná (upomínky a synchronizace by nefungovaly) a bezplatná databáze po 30 dnech zaniká – pro ostrý provoz nevhodné. Aktuální ceny ověřte na [render.com/pricing](https://render.com/pricing).

## Brevo (e-maily)
1. Účet na brevo.com (bezplatný plán má denní limit odeslaných e-mailů – ověřte aktuální limit; pro malé studio stačí).
2. **Senders, Domains & Dedicated IPs → Domains**: přidejte a ověřte svou doménu (DNS záznamy **SPF, DKIM, DMARC** zadejte u správce domény). Bez ověřené domény půjdou e-maily do spamu nebo je Brevo odmítne.
3. **SMTP & API → API keys**: vytvořte klíč → `BREVO_API_KEY`. `MAIL_FROM_EMAIL` musí být adresa na ověřené doméně.
4. Webhook (volitelně, pro stav doručení): Brevo → Transactional → Settings → Webhook → URL `https://VAŠE-DOMÉNA/api/webhooks/brevo?secret=HODNOTA_BREVO_WEBHOOK_SECRET`, události delivered / hardBounce / softBounce / blocked / spam.
5. V administraci **E-maily → Poslat zkušební** ověřte doručení. Dokud není Brevo nastaveno, e-maily mají stav „skipped“ a systém to **nevydává za odeslané**.

## Google Kalendář
1. [Google Cloud Console](https://console.cloud.google.com) → nový projekt → **APIs & Services → Library → Google Calendar API → Enable**.
2. **OAuth consent screen**: typ External, název aplikace, e-mail, scope `…/auth/calendar` (čtení i zápis událostí) a `…/auth/userinfo.email`.
3. ⚠️ **Publikujte aplikaci (Publishing status → In production).** V režimu *Testing* Google **po 7 dnech zneplatní refresh token** a synchronizace by se přerušila (systém to pozná, přepne se na `needs_reauth` a pošle upozornění, ale rezervace by se pozastavily). Pro osobní použití jedním účtem stačí publikovat bez ověření aplikace; Google zobrazí varování „neověřená aplikace“ – v dialogu zvolte *Pokročilé → Pokračovat*. Citlivý scope může při větším rozsahu vyžadovat ověření Googlem; pro jeden vlastní účet to není nutné.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Authorized redirect URI: `https://VAŠE-DOMÉNA/api/admin/calendar/callback/google`. Hodnoty uložte do `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` na Renderu (restart).
5. V administraci **Nastavení → Kalendář → Propojit Google Kalendář**, přihlaste se, pak vyberte které kalendáře blokují termíny a do kterého se zapisují rezervace (může jich blokovat víc, zapisuje se do jednoho).
Push upozornění (okamžitá reakce na změnu) funguje na veřejné https adrese; jinak systém načítá změny každé 2 minuty.

## Outlook / Microsoft 365
1. [Entra ID (Azure) → App registrations → New registration](https://entra.microsoft.com), typ účtů dle potřeby (osobní + pracovní → `MS_TENANT=common`).
2. Redirect URI (Web): `https://VAŠE-DOMÉNA/api/admin/calendar/callback/microsoft`.
3. **API permissions (Delegated):** `Calendars.ReadWrite`, `offline_access`, `User.Read`.
4. **Certificates & secrets → New client secret** → `MS_CLIENT_SECRET`; Application (client) ID → `MS_CLIENT_ID`. Secret má expiraci – poznamenejte si datum obnovy.
5. V administraci propojte stejně jako Google.

## Apple Kalendář
**Není podporován a není to opomenutí.** iCloud kalendář nemá OAuth ani push notifikace; zbývá CalDAV s heslem aplikace a nepřetržité dotazování, což není spolehlivé ani bezpečné pro obousměrnou synchronizaci. Řešení: používejte Google nebo Outlook jako „hlavní“ kalendář a v něm sdílejte/přidejte iCloud kalendář (iPhone umí do Google/Outlook kalendáře zapisovat přímo). Administrace to uvádí u propojení.

## Instagram
Odkaz na profil je v **Obsah webu → Instagram – odkaz**. Zobrazení příspěvků přímo na webu je možné **jen oficiálním Instagram API** (profesionální účet + aplikace v Meta for Developers → přístupový token), vložte token v **Nastavení → Instagram**. Token se obnovuje automaticky úlohou na pozadí. Bez tokenu se příspěvky nezobrazují a nic se negrabuje. Alternativa: fotografie nahrajte do **Galerie** (jen vlastní nebo se svolením).

## Vlastní doména
Render → webová služba → **Settings → Custom Domains** → přidejte `www.vasedomena.cz` → u správce domény nastavte `CNAME` na adresu, kterou Render ukáže (u holé domény záznam `A`/`ALIAS` dle instrukcí Renderu). HTTPS certifikát vystaví Render automaticky. Pak změňte `BASE_URL`, redirect URI u Google/Microsoft a webhook v Brevo.

## Lokální vývoj a testy
```bash
createdb hasnails && createdb hasnails_test
cp .env.example .env           # vyplňte DATABASE_URL; ENCRYPTION_KEY pro vývoj není povinný
npm install
node --env-file=.env src/server.js        # http://localhost:3000, /admin
DATABASE_URL=postgres://…/hasnails_test npm test
```
Testy **mažou schéma** zadané databáze – používejte vždy oddělenou testovací databázi. Pokrytí: časové zóny a přechod letní/zimní čas, výpočet dostupnosti, souběh (20 paralelních požadavků → 1 úspěch; 12 paralelních INSERTů → 1 úspěch + 11× kolize na úrovni databáze), ověření e-mailu a limit pokusů, oprávnění (cizí rezervace, CSRF, role), synchronizace kalendáře proti **simulovanému** poskytovateli (zápis, osobní události, posun/smazání, více kalendářů, celodenní, výpadek, ztráta autorizace, zastaralá data, rozdíly), e-maily (deduplikace, opakování, nenakonfigurováno), registrace/obnova hesla/zamykání/smazání účtu.

## Provoz, zálohy, GDPR
- **Zálohy:** placená databáze na Renderu má automatické zálohy (ověřte u zvoleného plánu retenci); doporučeno navíc pravidelně dělat `pg_dump`. Zálohujte i `ENCRYPTION_KEY` (do správce hesel).
- **Monitoring:** `/healthz`; v administraci Přehled (výpadek kalendáře, neodeslané e-maily, rozdíly). Správce dostává e-mail při výpadku synchronizace.
- **GDPR:** ukládají se jen jméno, e-mail, telefon, poznámka a historie rezervací; souhlas s podmínkami při rezervaci; klientka může smazat účet (osobní údaje se anonymizují, historie zůstává bez identifikace); těla odeslaných e-mailů se z logu mažou; doba uchování se nastavuje (výchozí 24 měsíců, automatický úklid). Texty **Obchodní podmínky** a **Ochrana osobních údajů** jsou jen vzorová šablona – nechte je schválit právníkem a doplňte IČO/sídlo provozovatele.
- Bezpečnost: hesla scrypt, sezení v DB (HttpOnly cookie), CSRF token + kontrola Origin, omezení počtu pokusů, přísné CSP bez inline skriptů, šifrované tokeny, tajemství jen v proměnných prostředí.

## Náklady
Orientačně (ověřte aktuální ceníky): Render web starter ≈ 7 USD/měs. + databáze ≈ 6 USD/měs.; Brevo zdarma pro malý objem; Google/Microsoft API zdarma pro tento rozsah; doména ≈ 200–400 Kč/rok. Google Maps je vložen bez API klíče (prostý odkaz + vložená mapa), takže bez poplatků.

## Co je ověřeno a co ne
**Ověřeno automatickými testy a v prohlížeči (lokálně, PostgreSQL):** pravidla dostupnosti, ochrana proti dvojí rezervaci, rezervační tok od výběru služby po potvrzení (mobilní rozlišení), správa rezervace odkazem z e-mailu, účty, administrace (všechny stránky se načtou bez chyb a bez porušení CSP), logika synchronizace kalendáře.
**Neověřeno proti skutečným službám** (nebyly k dispozici přihlašovací údaje ani povolený výstup na internet): komunikace s Google Calendar API, Microsoft Graph, Brevo a Instagram API. Kód je napsán podle jejich dokumentace a logika synchronizace je otestována proti simulovanému poskytovateli, ale **první ostrý test s vaším účtem je nutný** (zkušební e-mail, propojení kalendáře, vytvoření a smazání zkušební události). Zvláště zpracování celodenních událostí u Microsoftu je přibližné.
**Obsahově nedoplněno (záměrně nic nevymýšlíme):** služby a ceny (referenční web patřil jiné provozovně a nebyl dostupný ke čtení – zadejte skutečný ceník v administraci), pracovní doba, fotografie, příspěvky z Instagramu, kontaktní e-mail. Online rezervace jsou po instalaci **vypnuté**.
**Další omezení:** mezi vytvořením události v kalendáři a dalším načtením může být okno (zmírněno okamžitou synchronizací před přijetím rezervace); push upozornění vyžadují veřejnou https adresu; v repozitáři není `package-lock.json` (instalace bez zamčených verzí – po prvním `npm install` ho commitněte).

## Kontrolní seznam spuštění
- [ ] Nasazeno, `/healthz` ok, přihlášení do `/admin`, změněno heslo, smazáno `ADMIN_INITIAL_PASSWORD`
- [ ] Zadány služby a ceny, pracovní doba, kontaktní údaje
- [ ] Brevo: doména ověřena (SPF/DKIM/DMARC), zkušební e-mail dorazil
- [ ] Kalendář propojen, vybrán zapisovací kalendář, zkušební rezervace se objevila v kalendáři a osobní událost zablokovala termín
- [ ] Zkontrolovány právní texty a storno podmínky; v Nastavení potvrzeno „zkontrolováno“
- [ ] Zapnuty online rezervace

## Údržba a rozšiřování
- Změny schématu = nový soubor `migrations/NNN_popis.sql` (spouští se automaticky při startu pod zámkem).
- Nový poskytovatel kalendáře = nový modul v `src/calendar/` se stejným rozhraním jako `google.js` + registrace v `providers.js`; test proti `FakeCalendar` v `test/helpers.js`.
- Aktualizace závislostí: `npm outdated`, změny vždy nejdřív pustit proti testům. Sledujte expiraci Microsoft client secretu a (u Googlu) stav publikace OAuth aplikace.
