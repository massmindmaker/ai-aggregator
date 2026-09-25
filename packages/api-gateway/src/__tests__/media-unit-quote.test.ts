import { describe, expect, it } from 'vitest';
import { quoteMediaUnits } from '../billing/media-unit-quote';

describe('exact media unit quote',()=>{
  it('quotes image units and markup exactly in microcredits',()=>{
    expect(quoteMediaUnits({priceCentsPerUnit:'0.015',markup:'1.8'},4)).toEqual({
      formulaVersion:'media-unit-microcredits-v1',supplierFormulaVersion:'media-supplier-unit-microcredits-v1',
      units:4,supplierMaxMicrocredits:60n,retailMaxMicrocredits:108n,
    });
    expect(quoteMediaUnits({priceCentsPerUnit:'50.0000000000',markup:'1.8000'},1).retailMaxMicrocredits).toBe(90000n);
  });
  it('ceil-rounds tiny positive supplier and retail amounts',()=>{
    expect(quoteMediaUnits({priceCentsPerUnit:'0.0001',markup:'1.25'},1)).toMatchObject({
      supplierMaxMicrocredits:1n,retailMaxMicrocredits:1n,
    });
  });
  it.each(['',' 1','+1','1e2','NaN','0','00.1','1.'])('rejects invalid/zero price %s',(v)=>{
    expect(()=>quoteMediaUnits({priceCentsPerUnit:v,markup:'1.2'},1)).toThrow();
  });
  it.each(['0','-1','1e2',' 1','NaN'])('rejects invalid markup %s',(v)=>{
    expect(()=>quoteMediaUnits({priceCentsPerUnit:'1',markup:v},1)).toThrow();
  });
  it.each([0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('rejects invalid units %s',(v)=>{
    expect(()=>quoteMediaUnits({priceCentsPerUnit:'1',markup:'1'},v)).toThrow();
  });
  it('rejects PostgreSQL bigint overflow',()=>{
    expect(()=>quoteMediaUnits({priceCentsPerUnit:'9223372036854775.807',markup:'1000'},1000)).toThrow(/BIGINT/);
  });
});
