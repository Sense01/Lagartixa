import { sleep } from './util.js';

// ---------- Cookies / banners de consentimento ----------
const ACCEPT = /^\s*(tout accepter|accepter( tout| et fermer| les cookies| tous les cookies)?|j['’]accepte|accept all( cookies)?|accept( cookies)?|allow all( cookies)?|allow cookies|i agree|agree( and close)?|aceitar( tudo| todos)?( os cookies)?|aceito|concordo|aceptar( todo| todas)?( las cookies)?|alle akzeptieren|akzeptieren|accetta( tutto| tutti)?)\s*$/i;
const REJECT = /^\s*(tout refuser|refuser( tout| les cookies)?|continuer sans accepter|reject all( cookies)?|reject( cookies)?|decline( all)?|deny( all)?|only necessary|recusar( tudo| todos)?|rejeitar( tudo| todos)?|rechazar( todo| todas)?|alle ablehnen|ablehnen|rifiuta( tutto| tutti)?)\s*$/i;
const CMP = {
  accept: ['#onetrust-accept-btn-handler', '#didomi-notice-agree-button', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '.fc-cta-consent', '#truste-consent-button', '[data-testid="uc-accept-all-button"]'],
  reject: ['#onetrust-reject-all-handler', '#didomi-notice-disagree-button', '#CybotCookiebotDialogBodyButtonDecline', '.fc-cta-do-not-consent', '[data-testid="uc-deny-all-button"]'],
};

export async function dismissConsent(page, mode) {
  const order = mode === 'reject' ? [REJECT, ACCEPT] : [ACCEPT, REJECT];
  for (let round = 0; round < 2; round++) { // alguns banners têm um 2.º passo
    let clicked = false;
    for (const sel of CMP[mode] || CMP.accept) { // 1) plataformas de consentimento conhecidas
      try {
        const b = page.locator(sel).first();
        if (await b.isVisible()) { await b.click({ timeout: 1500 }); clicked = true; break; }
      } catch {}
    }
    for (const re of clicked ? [] : order) { // 2) botões pelo texto, em todas as frames (iframes incluídas)
      for (const frame of page.frames()) {
        try {
          const b = frame.locator('button:visible, a:visible, [role="button"]:visible', { hasText: re }).first();
          if (await b.count()) { await b.click({ timeout: 1500 }); clicked = true; break; }
        } catch {}
      }
      if (clicked) break;
    }
    if (!clicked) break;
    await sleep(600);
  }
}
