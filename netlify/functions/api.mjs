// API du registre : /api/vote (POST), /api/resultats (GET), /api/registre (GET, clé admin)
import { getStore } from "@netlify/blobs";

const SUSPECTS = ["duo", "hamza", "talel-hajer", "ktates"];
const LIMITE_PAR_RESEAU_ET_PAR_HEURE = 150;

const store = () => getStore({ name: "affaire-cvl", consistency: "strong" });

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

async function compter(s) {
  const counts = {};
  await Promise.all(
    SUSPECTS.map(async (id) => {
      const { blobs } = await s.list({ prefix: `vote/${id}/` });
      counts[id] = blobs.length;
    })
  );
  const total = SUSPECTS.reduce((t, id) => t + counts[id], 0);
  return { counts, total };
}

async function empreinte(texte) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cvl-affaire:" + texte));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function voter(req, context) {
  let body;
  try { body = await req.json(); } catch { return json({ erreur: "Déposition illisible." }, 400); }

  const pick = String(body?.pick ?? "");
  const device = String(body?.device ?? "");
  if (!SUSPECTS.includes(pick)) return json({ erreur: "Ce suspect n’existe pas." }, 400);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return json({ erreur: "Appareil non reconnu. Recharge la page." }, 400);
  const pseudo = String(body?.pseudo ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 24);

  const s = store();

  // Garde-fou anti-bourrage : un même réseau ne peut pas déposer à l'infini.
  const heure = Math.floor(Date.now() / 3_600_000);
  const cleReseau = `reseau/${await empreinte(context?.ip || "inconnu")}`;
  const reseau = await s.get(cleReseau, { type: "json" });
  const deja = reseau && reseau.heure === heure ? reseau.n : 0;
  if (deja >= LIMITE_PAR_RESEAU_ET_PAR_HEURE) {
    return json({ erreur: "Trop de dépositions depuis ce réseau. Réessaie dans une heure." }, 429);
  }
  await s.setJSON(cleReseau, { heure, n: deja + 1 });

  // Un vote par appareil : changer d'avis remplace l'ancien vote.
  const cleAppareil = `appareil/${device}`;
  const avant = await s.get(cleAppareil, { type: "json" });
  if (avant?.pick && avant.pick !== pick) await s.delete(`vote/${avant.pick}/${device}`);
  await s.setJSON(`vote/${pick}/${device}`, { pseudo, at: new Date().toISOString() });
  await s.setJSON(cleAppareil, { pick });

  return json({ ok: true, ...(await compter(s)) });
}

async function registre(req) {
  const cle = globalThis.Netlify?.env?.get("ADMIN_KEY") ?? process.env.ADMIN_KEY;
  if (!cle) return json({ erreur: "La clé n’est pas encore réglée sur Netlify (variable ADMIN_KEY)." }, 503);
  if ((req.headers.get("x-cle") || "") !== cle) return json({ erreur: "Clé incorrecte." }, 401);

  const s = store();
  const votes = [];
  for (const id of SUSPECTS) {
    const { blobs } = await s.list({ prefix: `vote/${id}/` });
    for (let i = 0; i < blobs.length; i += 40) {
      const lot = await Promise.all(blobs.slice(i, i + 40).map((b) => s.get(b.key, { type: "json" })));
      lot.forEach((v) => votes.push({ pick: id, pseudo: v?.pseudo || "", at: v?.at || null }));
    }
  }
  votes.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const counts = Object.fromEntries(SUSPECTS.map((id) => [id, votes.filter((v) => v.pick === id).length]));
  return json({ counts, total: votes.length, votes });
}

export default async (req, context) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (path === "/api/vote" && req.method === "POST") return await voter(req, context);
    if (path === "/api/resultats" && req.method === "GET") {
      return json(await compter(store()), 200, {
        "cache-control": "public, max-age=0, must-revalidate",
        "netlify-cdn-cache-control": "public, s-maxage=10, stale-while-revalidate=30",
      });
    }
    if (path === "/api/registre" && req.method === "GET") return await registre(req);
    return json({ erreur: "Adresse inconnue." }, 404);
  } catch (e) {
    console.error(e);
    return json({ erreur: "Le registre ne répond pas. Réessaie dans un instant." }, 500);
  }
};

export const config = { path: ["/api/vote", "/api/resultats", "/api/registre"] };
