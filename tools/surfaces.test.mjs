import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSurfaces, inArea } from '../web/js/surfaces.js';

const water = { outer: [[-30,-30],[30,-30],[30,30],[-30,30]], holes: [] };
const terrain = (x) => Math.abs(x) < 30 ? -4 : 2;
const road = (id, points, extra = {}) => ({ id, points, width: 8, kind: 'primary', ...extra });

test('a bridge follows its land anchors instead of the riverbed; connected ways share the deck', () => {
  const a = road('a', [[-80,0],[-50,0]]), b = road('b', [[-50,0],[0,0]], {bridge:true,layer:1});
  const c = road('c', [[0,0],[50,0]], {bridge:true,layer:1}), d = road('d', [[50,0],[80,0]]);
  const s = makeSurfaces({size:300,water:[water],roads:[a,b,c,d]}, null, terrain);
  assert.equal(s.bridgeDecks.length, 1);
  assert.equal(s.heightFor(b, 0, 0), 2);
  assert.equal(s.heightFor(c, 0, 0), 2);
  assert.equal(s.heightFor(a, -70, 0), terrain(-70));
  assert.equal(s.surfaceAt(0, 0), 2);
  assert.equal(s.groundAt(0, 0), -4.07);
});

test('water is coherent and holes remain land', () => {
  const lake = {...water,holes:[[[-5,-5],[5,-5],[5,5],[-5,5]]]};
  const s = makeSurfaces({size:300,water:[lake],roads:[]}, null, (x,y)=>Math.abs(x)<20&&Math.abs(y)<20 ? 3 : 12);
  assert.equal(inArea(0,0,lake), false);
  assert.equal(s.waterHeightAt(0,0), null);
  assert.equal(s.groundAt(0,0),3);
  assert.equal(s.waterHeightAt(10,0),s.waterHeightAt(-10,10));
  assert.ok(s.groundAt(10,0)<s.waterHeightAt(10,0));
});

test('a narrow canal between grid rows samples its bed instead of its elevated banks', () => {
  const canal = {outer:[[-120,8],[120,8],[120,12],[-120,12]],holes:[]};
  const s = makeSurfaces({size:300,water:[canal],roads:[]},null,(x,y)=>y>9&&y<11 ? -3 : 6);
  assert.equal(s.waterHeightAt(0,10),-2.95);
  assert.ok(s.groundAt(0,10)<s.waterHeightAt(0,10));
});

test('a thin diagonal waterway is sampled even when its bounding box is large', () => {
  const stream = {outer:[[-400,-398],[398,400],[400,398],[-398,-400]],holes:[]};
  const s = makeSurfaces({size:300,water:[stream],roads:[]},null,(x,y)=>Math.abs(x-y)<1 ? -5 : 8);
  assert.equal(s.waterHeightAt(0,0),-4.95);
});

test('unanchored decks are marked estimated, while a curated height uses the local datum', () => {
  const b=road('b',[[-20,0],[20,0]],{bridge:true,layer:1});
  const city={size:300,water:[water],roads:[b]};
  const estimated=makeSurfaces(city,null,terrain);
  assert.equal(estimated.bridgeDecks[0].estimated,true);
  assert.ok(estimated.heightFor(b,0,0)>estimated.waterHeightAt(0,0));
  const curated=makeSurfaces(city,{baseElevation:10},terrain,{deckHint:()=>57});
  assert.equal(curated.heightFor(b,0,0),57);
  assert.equal(curated.bridgeDecks[0].estimated,false);
});

test('different bridge levels stay separate; tunnels never become elevated decks', () => {
  const a=road('a',[[-20,0],[0,0],[20,0]],{bridge:true,layer:1});
  const b=road('b',[[0,-20],[0,0],[0,20]],{bridge:true,layer:2});
  const tunnel=road('t',[[0,-20],[0,20]],{bridge:true,layer:-1,tunnel:true});
  const s=makeSurfaces({size:300,roads:[a,b,tunnel],water:[]},null,()=>0);
  assert.equal(s.bridgeDecks.length,2);
  assert.ok(s.heightFor(b,0,0)>s.heightFor(a,0,0));
  assert.equal(s.profiles.has(tunnel),false);
});

test('a mapped water elevation needs a finite datum; otherwise the level is estimated from terrain', () => {
  const mapped = { ...water, elevation: 10 };
  const withDatum = makeSurfaces({ size: 300, water: [mapped], roads: [] }, { baseElevation: 4 }, terrain);
  assert.equal(withDatum.waterHeightAt(0, 0), 6.05);
  for (const elevation of [{}, { baseElevation: NaN }, null]) {
    const s = makeSurfaces({ size: 300, water: [mapped], roads: [] }, elevation, terrain);
    assert.ok(Number.isFinite(s.waterHeightAt(0, 0)), 'water level must stay finite');
    assert.ok(Number.isFinite(s.groundAt(0, 0)), 'water must not poison the ground height');
    assert.ok(s.waterHeightAt(0, 0) < 0, 'estimated from the riverbed, not the mapped elevation');
  }
});
