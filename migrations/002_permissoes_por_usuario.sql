-- Permissões por pessoa: lista das áreas que cada usuário pode ver.
-- NULL = usa o padrão do perfil. O Admin sempre vê tudo.
ALTER TABLE users ADD COLUMN permissions text[];
