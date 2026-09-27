import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPgTestClient } from '../pg-test-client';
import { assertTestDatabaseEnvironment, withGuardedTestDatabase } from '../test-db-guard';

const enabled = process.env.RUN_NATIVE_DB_INTEGRATION === '1';
if (enabled) assertTestDatabaseEnvironment(process.env);

describe.skipIf(!enabled)('durable batch schema native', () => {
  it('installs additive durable parent/item ownership without secret columns', async () => {
    await withGuardedTestDatabase(process.env, { clientFactory: createPgTestClient }, async (client) => {
      const tables = await client.query<{ batches:string|null; batch_items:string|null }>({
        text:`SELECT to_regclass('public.batches')::text AS batches,
                    to_regclass('public.batch_items')::text AS batch_items`,
        values:[],
      });
      expect(tables.rows[0]).toEqual({ batches:'batches', batch_items:'batch_items' });

      const columns = await client.query<{ table_name:string; column_name:string }>({
        text:`SELECT table_name,column_name
                FROM information_schema.columns
               WHERE table_schema='public'
                 AND table_name=ANY($1::text[])
               ORDER BY table_name,ordinal_position`,
        values:[['batches','batch_items']],
      });
      const byTable = new Map<string,string[]>();
      for (const row of columns.rows) {
        const list = byTable.get(row.table_name) ?? [];
        list.push(row.column_name);
        byTable.set(row.table_name,list);
      }
      expect(byTable.get('batches')).toEqual(expect.arrayContaining([
        'contract_version','billing_mode','idempotency_key_digest','request_fingerprint',
        'queued_at','reconcile_after','terminal_at',
      ]));
      expect(byTable.get('batch_items')).toEqual(expect.arrayContaining([
        'id','batch_id','item_index','custom_id','route_kind','request_fingerprint','request_body',
        'billing_request_id','attempt_id','model_slug','model_upstream_id','upstream_id',
        'upstream_model_id','adapter_key','pricing_snapshot','provider_request','status','output','error_code','result_digest',
        'deadline_at','settled_at','created_at','updated_at',
      ]));
      expect(byTable.get('batch_items')).not.toEqual(expect.arrayContaining([
        'api_key','byok_key','proxy_credential','provider_response','provider_task_id','egress_proxy_url',
      ]));

      const constraints = await client.query<{ name:string; def:string }>({
        text:`SELECT conname AS name,pg_get_constraintdef(oid) AS def
                FROM pg_constraint
               WHERE conrelid IN ('public.batches'::regclass,'public.batch_items'::regclass)
                 AND contype IN ('u','f')
               ORDER BY conname`,
        values:[],
      });
      const defs = constraints.rows.map((row)=>row.def);
      expect(defs.some((def)=>def.includes('UNIQUE (org_id, contract_version, billing_mode, idempotency_key_digest)'))).toBe(true);
      expect(defs.some((def)=>def.includes('UNIQUE (batch_id, item_index)'))).toBe(true);
      expect(defs.some((def)=>def.includes('UNIQUE (batch_id, custom_id)'))).toBe(true);
      expect(defs.some((def)=>def.includes('UNIQUE (billing_request_id)'))).toBe(true);
      expect(defs.some((def)=>def.includes('FOREIGN KEY (batch_id) REFERENCES batches(id)'))).toBe(true);
      expect(defs.some((def)=>def.includes('FOREIGN KEY (billing_request_id) REFERENCES gateway_charge_admissions(billing_request_id)')
        && def.includes('DEFERRABLE INITIALLY DEFERRED'))).toBe(true);

      const indexes = await client.query<{ indexname:string }>({
        text:`SELECT indexname FROM pg_indexes
               WHERE schemaname='public'
                 AND indexname=ANY($1::text[])
               ORDER BY indexname`,
        values:[['batches_reconcile_idx','batch_items_claim_idx','batch_items_billing_idx']],
      });
      expect(indexes.rows.map((row)=>row.indexname)).toEqual([
        'batch_items_billing_idx','batch_items_claim_idx','batches_reconcile_idx',
      ]);

      const identityCheck = await client.query<{ def:string }>({
        text:`SELECT pg_get_constraintdef(oid) AS def
                FROM pg_constraint
               WHERE conrelid='public.batches'::regclass
                 AND conname='batches_durable_identity_check'`,
        values:[],
      });
      expect(identityCheck.rows[0]?.def).toContain('billing_mode IS NOT NULL');
      expect(identityCheck.rows[0]?.def).toContain('idempotency_key_digest IS NOT NULL');
      expect(identityCheck.rows[0]?.def).toContain('request_fingerprint IS NOT NULL');
    });
  }, 30000);

  it('rejects every nullable v5 identity hole and duplicate parent scope', async () => {
    await withGuardedTestDatabase(process.env, { clientFactory: createPgTestClient }, async (client) => {
      const orgId=randomUUID();
      const digest='a'.repeat(64);
      const fingerprint='b'.repeat(64);
      const insert = async (billingMode:string|null,keyDigest:string|null,requestFingerprint:string|null) => {
        await client.query({text:'BEGIN',values:[]});
        try {
          await expect(client.query({
            text:`INSERT INTO batches(
                    batch_id,org_id,type,status,input_file_url,expires_at,contract_version,
                    billing_mode,idempotency_key_digest,request_fingerprint
                  ) VALUES($1,$2::uuid,'chat','queued',$3,clock_timestamp()+interval '1 day',5,$4,$5,$6)`,
            values:['batch_'+randomUUID().replaceAll('-',''),orgId,'inline:test',billingMode,keyDigest,requestFingerprint],
          })).rejects.toThrow();
        } finally {
          await client.query({text:'ROLLBACK',values:[]});
        }
      };
      await insert(null,digest,fingerprint);
      await insert('stored',null,fingerprint);
      await insert('stored',digest,null);

      await client.query({text:'BEGIN',values:[]});
      try {
        const values=[orgId,'inline:test','stored',digest,fingerprint];
        await client.query({
          text:`INSERT INTO batches(
                  batch_id,org_id,type,status,input_file_url,expires_at,contract_version,
                  billing_mode,idempotency_key_digest,request_fingerprint
                ) VALUES($1,$2::uuid,'chat','queued',$3,clock_timestamp()+interval '1 day',5,$4,$5,$6)`,
          values:['batch_'+randomUUID().replaceAll('-',''),...values],
        });
        await expect(client.query({
          text:`INSERT INTO batches(
                  batch_id,org_id,type,status,input_file_url,expires_at,contract_version,
                  billing_mode,idempotency_key_digest,request_fingerprint
                ) VALUES($1,$2::uuid,'chat','queued',$3,clock_timestamp()+interval '1 day',5,$4,$5,$6)`,
          values:['batch_'+randomUUID().replaceAll('-',''),...values],
        })).rejects.toThrow();
      } finally {
        await client.query({text:'ROLLBACK',values:[]});
      }
    });
  }, 30000);
});
