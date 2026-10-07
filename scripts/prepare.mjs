// Met la vraie adresse du site dans les balises de partage (aperçu Insta / WhatsApp).
import { readFileSync, writeFileSync } from "node:fs";

const url = (process.env.URL || "").replace(/\/$/, "");
const file = "public/index.html";
writeFileSync(file, readFileSync(file, "utf8").replaceAll("__SITE_URL__", url));
console.log("Adresse du site pour les aperçus :", url || "(inconnue)");
