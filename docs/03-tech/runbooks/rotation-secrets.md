# Runbook : rotation des secrets

Inventaire des secrets de l'API (`apps/api/src/config.ts`) : `WS_TICKET_SECRET`, mot de passe de la base dans `DATABASE_URL`. Côté OIDC, l'API ne détient aucun secret : seulement `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` (clés publiques). Le client web OIDC (PKCE) est public, sans secret (`VITE_OIDC_CLIENT_ID`). Les secrets vivent dans le gestionnaire de secrets de l'hébergement, jamais dans le dépôt (le scan `npm run scan` le contrôle).

## WS_TICKET_SECRET

Rôle : signe les tickets d'upgrade WebSocket (HMAC, valables 30 s, un par connexion, `apps/api/src/tickets.ts`). Pas de rotation à double secret : tout ticket signé avec l'ancien secret est refusé dès le nouveau en place.

Fréquence : tous les 90 jours et à toute suspicion de fuite.

1. Générer : `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (>= 32 caractères exigés au démarrage).
2. Poser la nouvelle valeur dans le gestionnaire de secrets, identique pour TOUTES les instances.
3. Redéployer toutes les instances d'un coup (pas de rolling) : en rolling, un ticket émis par une instance peut être refusé par une autre pendant au plus 30 s ; effet limité (le client redemande un ticket et se reconnecte, attente de 5 s au moins), pas de perte de données.
4. Vérifier : `POST /api/v1/realtime/ticket` répond un ticket, une connexion WebSocket arrive à `ready` (`npm run perf:realtime` en local avec le même mécanisme), pas de rafale de 401/429 dans les logs.
5. Les sessions WebSocket déjà ouvertes ne sont pas coupées (le ticket ne sert qu'à l'upgrade) ; pour forcer, redémarrer l'API.

Au démarrage, une valeur absente ou de moins de 32 caractères arrête le processus (en production : absente = refus).

## OIDC (clés de signature du fournisseur)

L'API récupère les clés publiques au `OIDC_JWKS_URL` (cache 10 min, rechargement sur `kid` inconnu au plus toutes les 30 s ; RS256 >= 2048 bits ou ES256 P-256). La rotation se fait chez le fournisseur et ne demande aucun redéploiement :

1. Publier la nouvelle clé dans le JWKS AVANT de signer avec elle (les deux clés coexistent le temps de la durée de vie maximale des jetons).
2. Basculer la signature sur la nouvelle clé.
3. Retirer l'ancienne clé après l'expiration des jetons émis.
4. Vérifier : un jeton neuf passe (`GET /api/v1/schedule` avec `Authorization: Bearer`), un jeton à `kid` inconnu donne 401, une panne du JWKS donne 500 (pas 401). Essai local : `npm run dev:stack -- --oidc` (fournisseur `scripts/dev-idp.mjs`, `WNEXT_DEV_IDP_TOKEN_TTL` pour raccourcir les jetons).

Changement d'émetteur, d'audience ou d'URL JWKS : modifier `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URL` et redémarrer ; tous les jetons de l'ancien émetteur sont refusés, les utilisateurs se reconnectent. Le rattachement se fait par `users.idp_subject` (le `sub` doit rester stable, sinon réaffecter les sujets en base).

## Mot de passe de la base

Créer le nouveau mot de passe du rôle (`ALTER ROLE app_user PASSWORD '...'`), mettre à jour `DATABASE_URL`, redémarrer l'API ; le pool et la connexion d'écoute se rétablissent seuls (attente croissante) mais la nouvelle valeur n'est lue qu'au démarrage.

## En cas de fuite

Rotation immédiate du secret concerné, puis `npm run scan` (l'historique git complet est analysé), révocation côté fournisseur, et note d'incident dans `docs/03-tech/quality/`.
