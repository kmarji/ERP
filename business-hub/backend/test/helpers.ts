import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

export const PASSWORD = 'correct-horse-battery';

export async function createApp() {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app: INestApplication = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  return { app, http: request(app.getHttpServer()), prisma: app.get(PrismaService) };
}

export type Http = ReturnType<typeof request>;
export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function login(http: Http, tenant: string, email: string) {
  return (await http.post('/auth/login').send({ tenant, email, password: PASSWORD })).body.accessToken as string;
}

export async function newTenant(http: Http, label: string) {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const b = await http
    .post('/tenants/bootstrap')
    .set('x-bootstrap-token', 'dev-bootstrap-token')
    .send({ name: slug, slug, ownerEmail: `owner@${slug}.test`, ownerName: 'Owner', ownerPassword: PASSWORD })
    .expect(201);
  return { slug, tenantId: b.body.tenantId as string, legalEntityId: b.body.legalEntityId as string, ownerId: b.body.ownerId as string, token: await login(http, slug, `owner@${slug}.test`) };
}

export async function makeUser(http: Http, t: { slug: string; token: string }, key: string, roleKey: string, branchId?: string) {
  const email = `${key}@${t.slug}.test`;
  const u = await http.post('/users').set(auth(t.token)).send({ email, name: key, password: PASSWORD }).expect(201);
  await http.post(`/users/${u.body.id}/roles`).set(auth(t.token)).send({ roleKey, branchId }).expect(201);
  return { id: u.body.id as string, token: await login(http, t.slug, email) };
}

export const today = () => new Date().toISOString().slice(0, 10);
