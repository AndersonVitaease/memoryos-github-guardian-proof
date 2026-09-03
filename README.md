# memoryos-github-guardian-proof

> **EXPERIMENTAL**
> **GH-00**
> **Private proof**
> **Single purpose: governed GitHub Pull Request merge**

## O que este laboratório é

Repositório **privado e isolado**, criado **SOMENTE** para provar ou refutar a
hipótese do **GitHub Guardian** (proof **GH-00**).

## O que este laboratório NÃO é

- Não é o memoryos-vps-guardian nem o memoryos-vps-guardian-pro (intocados).
- Não reutiliza código dos repositórios VPS.
- Não é arquitetura genérica: sem adapters multiplataforma, sem policy engine,
  sem entitlement, sem RBAC, sem licensing, sem dashboard, sem servidor HTTP,
  sem abstrações futuras.
- Não contém a implementação do Guardian Core (ainda).

## Estrutura mínima

```
src/    fundação mínima TypeScript
test/   baseline Vitest
```

## Fundação

- Node.js
- TypeScript (strict)
- Vitest

## Comandos

```bash
npm install
npm run typecheck
npm test
```

## Critério de baseline

- `TYPECHECK=PASS`
- `TESTS=PASS`

## GH-00 Live Proof Fixture

This branch exists only as a harmless Pull Request fixture
for the governed GitHub merge proof.

Snapshot invalidation fixture: this commit deliberately changes the
Pull Request head SHA so a previously approved snapshot fingerprint
no longer matches the current state (GH-00 invalidation proof).
