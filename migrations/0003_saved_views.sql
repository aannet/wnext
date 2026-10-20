-- ============================================================
-- 0003_saved_views : visibilité des vues sauvegardées (FR-10)
-- ============================================================
-- La RLS de schema.sql n'isole que par compte (tenant_isolation, permissive). Une vue PRIVÉE ne doit pas être lisible par un autre
-- membre du même compte, même si l'API oubliait son filtre : politique RESTRICTIVE (s'ajoute en ET à tenant_isolation).
-- Visible = ma vue OU une vue partagée du compte. WITH CHECK (true) : les droits d'écriture (propriétaire, owner/admin sur une vue
-- partagée, partage réservé aux rôles d'écriture) restent dans l'API ; la lecture/modification d'une ligne reste limitée aux lignes visibles.
CREATE POLICY visible_saved_views ON saved_views AS RESTRICTIVE FOR ALL
  USING (owner_user_id = app_user_id() OR shared)
  WITH CHECK (true);
