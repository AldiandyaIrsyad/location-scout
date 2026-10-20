import test from 'node:test';
import assert from 'node:assert/strict';
import { composeContext, outsideSquare } from '../web/js/context.js';
import { clipTriangle, clipSegment, drapeTriangle, groundGridHeight } from '../web/js/surface-geometry.js';

test('outer streets retain both approaches without drawing across the detailed square', () => {
  assert.deepEqual(outsideSquare([[-200,0],[200,0]],100),[[[-200,0],[-100,0]],[[100,0],[200,0]]]);
  assert.deepEqual(outsideSquare([[-20,0],[20,0]],100),[]);
  assert.deepEqual(outsideSquare([[-200,120],[200,120]],100),[[[-200,120],[200,120]]]);
});

test('mapped areas, objects, trees and buildings are not duplicated at the detail boundary', () => {
  const water={id:'w1',outer:[[0,0],[1,0],[0,1]]};
  const city={size:300,water:[water],green:[],areas:[],props:[{id:'n1'}],buildings:[{id:'b1'}],trees:[[0,0]],roads:[],railways:[]};
  const ctx=composeContext(city,{contextSize:2000,water:[{...water}],props:[{id:'n1'},{id:'n2'}],trees:[[0,0],[400,0]],buildings:[{id:'b1'},{id:'b2'}]});
  assert.equal(ctx.water.length,1); assert.equal(ctx.water[0],water);
  assert.equal(ctx.props.length,2); assert.equal(ctx.trees.length,2); assert.deepEqual(ctx.contextBuildings,[{id:'b2'}]);
});

const area=t=>Math.abs((t[1][0]-t[0][0])*(t[2][1]-t[0][1])-(t[1][1]-t[0][1])*(t[2][0]-t[0][0]))/2;
test('bounded area clipping preserves area without extending a huge polygon beyond the ground', () => {
  const t=[[-200,-200],[200,-200],[0,200]],clipped=clipTriangle(t,50);
  assert.ok(clipped.length>0); assert.ok(clipped.flat().every(p=>p.every(v=>Math.abs(v)<=50)));
  assert.equal(clipped.reduce((n,t)=>n+area(t),0),10000);
});

test('outer land cover excludes the detailed square without losing area or crossing it', () => {
  const triangles=[[[-200,-200],[200,-200],[200,200]],[[-200,-200],[200,200],[-200,200]]];
  const ring=triangles.flatMap(t=>clipTriangle(t,100,30));
  assert.equal(ring.reduce((n,t)=>n+area(t),0),40000-3600);
  assert.ok(ring.every(t=>t.some(p=>Math.abs(p[0])>=30 || Math.abs(p[1])>=30)));
  const segments=clipSegment([-200,0],[200,0],100,30);
  assert.deepEqual(segments.map(s=>s.map(p=>p.map(v=>Math.round(v*1e6)/1e6))),[[[-100,0],[-30,0]],[[30,0],[100,0]]]);
});

test('land cover follows the ground triangle diagonal rather than cutting through a terrain cell', () => {
  const parts=[...drapeTriangle([[-5,-5],[5,-5],[5,5]],10,1,(x,y)=>x===5&&y===5?10:0)];
  assert.equal(parts.reduce((n,t)=>n+area(t),0),50);
  for(const t of parts)for(const [x,y,z]of t)assert.ok(Math.abs(z-Math.min(x+5,y+5))<1e-8);
  assert.ok(parts.every(t=>t.every(p=>p[0]>=p[1]-1e-8)||t.every(p=>p[1]>=p[0]-1e-8)));
});

test('full and boundary cells preserve terrain coverage, winding, and non-planar heights', () => {
  const heights=new Map([
    ['-10,-10',1],['0,-10',4],['10,-10',7],
    ['-10,0',9],['0,0',3],['10,0',11],
    ['-10,10',13],['0,10',17],['10,10',19],
  ]);
  const heightAt=(x,y)=>heights.get(`${x},${y}`);
  const ccw=[[-30,-10],[30,-30],[30,20]];
  const cw=[...ccw].reverse();
  const signed=t=>(t[1][0]-t[0][0])*(t[2][1]-t[0][1])-(t[1][1]-t[0][1])*(t[2][0]-t[0][0]);
  const parts=[...drapeTriangle(ccw,20,2,heightAt)];
  const reversed=[...drapeTriangle(cw,20,2,heightAt)];
  const cell=(x0,x1,y0,y1,source=parts)=>source.filter(t=>{
    const cx=(t[0][0]+t[1][0]+t[2][0])/3,cy=(t[0][1]+t[1][1]+t[2][1])/3;
    return cx>x0+1e-8&&cx<x1-1e-8&&cy>y0+1e-8&&cy<y1-1e-8;
  });
  assert.ok(parts.every(t=>signed(t)>0));
  assert.ok(reversed.every(t=>signed(t)<0));
  assert.ok(parts.flat().every(([x,y])=>x>=-10-1e-8&&x<=10+1e-8&&y>=-10-1e-8&&y<=10+1e-8));
  assert.equal(parts.reduce((n,t)=>n+area(t),0),300);
  assert.equal(cell(-10,0,-10,0).length,2);
  assert.equal(cell(0,10,-10,0).length,2);
  assert.equal(cell(-10,0,0,10).reduce((n,t)=>n+area(t),0),25);
  assert.equal(cell(0,10,0,10).reduce((n,t)=>n+area(t),0),75);
  const full=cell(-10,0,-10,0);
  assert.deepEqual(full.map(t=>t.map(([x,y,z])=>[x,y,z])).sort((a,b)=>String(a).localeCompare(String(b))),[
    [[-10,-10,1],[0,-10,4],[0,0,3]], [[-10,-10,1],[0,0,3],[-10,0,9]],
  ].sort((a,b)=>String(a).localeCompare(String(b))));
});

test('road height uses the rendered terrain triangles instead of a different bilinear surface', () => {
  const height=(x,y)=>x===5&&y===5?10:0;
  assert.equal(groundGridHeight(0,0,10,1,height),5);
  assert.equal(groundGridHeight(2,0,10,1,height),5);
  assert.equal(groundGridHeight(0,2,10,1,height),5);
  assert.equal(groundGridHeight(-5,-5,10,1,height),0);
});
