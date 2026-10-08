process.env.TZ = 'America/Sao_Paulo';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: (() => {
    const secret = isProduction ? required('SESSION_SECRET') : (process.env.SESSION_SECRET ?? 'segredo-de-desenvolvimento-nao-usar-em-producao');
    if (isProduction && secret.length < 32) throw new Error('SESSION_SECRET precisa ter pelo menos 32 caracteres');
    return secret;
  })(),
  timezone: 'America/Sao_Paulo',
};
