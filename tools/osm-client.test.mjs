import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCity, fetchSurroundings } from '../web/js/osm.js';

test('city and context requests bypass browser-cached responses from the previous schema', async t => {
  const urls=[];
  const data={props:[{id:'w1',kind:'statue'}],water:[{id:'w2'}]};
  t.mock.method(globalThis,'fetch',async url=>{urls.push(new URL(url,'http://localhost/'));return {ok:true,json:async()=>data};});
  assert.equal(await fetchCity({lat:-6.1754,lon:106.8272,size:300}),data);
  const context=await fetchSurroundings({lat:-6.1754,lon:106.8272,size:300,farSize:2000});
  assert.deepEqual(context,{...data,farSize:2000});
  assert.deepEqual(urls.map(u=>u.pathname),['/api/city','/api/surroundings']);
  for(const url of urls){assert.equal(url.searchParams.get('v'),'3');assert.equal(url.searchParams.get('lat'),'-6.1754');assert.equal(url.searchParams.get('size'),'300');}
  assert.equal(urls[1].searchParams.get('far'),'2000');
});
