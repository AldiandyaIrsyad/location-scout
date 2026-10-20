// Clip already-triangulated areas: holes stay holes, even when they cross the scene boundary.
export function groundGridHeight(x,y,size,segments,heightAt) {
  const step=size/segments,half=size/2;
  const ix=Math.max(0,Math.min(segments-1,Math.floor((x+half)/step)));
  const iy=Math.max(0,Math.min(segments-1,Math.floor((y+half)/step)));
  const x0=-half+ix*step,y0=-half+iy*step,u=Math.max(0,Math.min(1,(x-x0)/step)),v=Math.max(0,Math.min(1,(y-y0)/step));
  const sw=heightAt(x0,y0),se=heightAt(x0+step,y0),nw=heightAt(x0,y0+step),ne=heightAt(x0+step,y0+step);
  return v>=u ? sw+(ne-nw)*u+(nw-sw)*v : sw+(se-sw)*u+(ne-se)*v;
}

function boxes(half, exclude) {
  if (exclude >= half) return [];
  return exclude > 0 && exclude < half ? [[-half,-half,-exclude,half],[exclude,-half,half,half],[-exclude,-half,exclude,-exclude],[-exclude,exclude,exclude,half]] : [[-half,-half,half,half]];
}

function clipToBox(triangle, box) {
  let polygon = triangle;
  for (const [axis, sign, limit] of [[0,1,box[2]],[0,-1,-box[0]],[1,1,box[3]],[1,-1,-box[1]]]) {
    const next = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const da = limit - sign * a[axis], db = limit - sign * b[axis];
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    polygon = next;
    if (polygon.length < 3) return [];
  }
  return polygon.slice(1, -1).map((p, i) => [polygon[0], p, polygon[i + 2]]);
}

export function clipTriangle(triangle, half, exclude = 0) {
  return boxes(half, exclude).flatMap(box => clipToBox(triangle, box));
}

export function clipSegment(a, b, half, exclude = 0) {
  const out = [], d = [b[0]-a[0],b[1]-a[1]];
  for (const box of boxes(half, exclude)) {
    let lo = 0, hi = 1, valid = true;
    for (let axis = 0; axis < 2; axis++) {
      if (Math.abs(d[axis]) < 1e-12) { if (a[axis] < box[axis] || a[axis] > box[axis+2]) valid = false; continue; }
      const u = (box[axis]-a[axis])/d[axis], v = (box[axis+2]-a[axis])/d[axis];
      lo = Math.max(lo,Math.min(u,v)); hi = Math.min(hi,Math.max(u,v));
    }
    if (valid && hi > lo) out.push([[a[0]+d[0]*lo,a[1]+d[1]*lo],[a[0]+d[0]*hi,a[1]+d[1]*hi]]);
  }
  return out;
}

// Intersect land cover with the actual ground mesh cells, including their diagonal.
// Sampling just the polygon corners (or arbitrary subdivisions) can put it below terrain.
export function* drapeTriangle(triangle, size, segments, heightAt) {
  const step=size/segments, half=size/2;
  const index=v=>Math.max(0,Math.min(segments-1,Math.floor((v+half)/step)));
  const xs=triangle.map(p=>p[0]), ys=triangle.map(p=>p[1]);
  const fan=p=>p.slice(1,-1).map((v,i)=>[p[0],v,p[i+2]]);
  const cross=(a,b,p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
  const area=cross(triangle[0],triangle[1],triangle[2]);
  const winding=area>=0?1:-1;
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),e=1e-9;
  const boxArea=(maxX-minX)*(maxY-minY);
  const canFullCell=boxArea>0&&Math.abs(area)/boxArea>0.2&&maxX-minX>=step*2&&maxY-minY>=step*2;
  const inside=(px,py)=>{
    for(let i=0;i<3;i++){
      const a=triangle[i],b=triangle[(i+1)%3];
      if(winding*((b[0]-a[0])*(py-a[1])-(b[1]-a[1])*(px-a[0]))<-e)return false;
    }
    return true;
  };
  // A convex cell whose four corners are inside the source triangle needs no
  // polygon clipping. Emit the exact two terrain-grid triangles directly;
  // cells touched by the boundary continue through the clipping path below.
  const fullCell=(x,y)=>{
    if(x<minX||x+step>maxX||y<minY||y+step>maxY||!inside(x+step/2,y+step/2))return false;
    return inside(x,y)&&inside(x+step,y)&&inside(x+step,y+step)&&inside(x,y+step);
  };
  const diagonal=(polygon,x,y,sign)=>{
    const out=[];
    for(let i=0;i<polygon.length;i++){
      const a=polygon[i],b=polygon[(i+1)%polygon.length];
      const da=sign*((a[1]-y)-(a[0]-x)),db=sign*((b[1]-y)-(b[0]-x));
      if(da>=0)out.push(a);
      if((da>=0)!==(db>=0)){const t=da/(da-db);out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
    }
    return fan(out);
  };
  for(let ix=index(Math.min(...xs));ix<=index(Math.max(...xs));ix++)for(let iy=index(Math.min(...ys));iy<=index(Math.max(...ys));iy++){
    const x=-half+ix*step,y=-half+iy*step;
    if(canFullCell&&fullCell(x,y)){
      const sw=heightAt(x,y),se=heightAt(x+step,y),nw=heightAt(x,y+step),ne=heightAt(x+step,y+step);
      const first=[[x,y,sw],[x+step,y,se],[x+step,y+step,ne]];
      const second=[[x,y,sw],[x+step,y+step,ne],[x,y+step,nw]];
      if(winding<0){first.reverse();second.reverse();}
      yield first;
      yield second;
      continue;
    }
    const clipped=clipToBox(triangle,[x,y,x+step,y+step]);
    if(!clipped.length)continue;
    const sw=heightAt(x,y),se=heightAt(x+step,y),nw=heightAt(x,y+step),ne=heightAt(x+step,y+step);
    for(const t of clipped)for(const sign of [1,-1])for(const piece of diagonal(t,x,y,sign)){
      const area=(piece[1][0]-piece[0][0])*(piece[2][1]-piece[0][1])-(piece[1][1]-piece[0][1])*(piece[2][0]-piece[0][0]);
      if(Math.abs(area)<1e-9)continue;
      yield piece.map(([px,py])=>{const u=(px-x)/step,v=(py-y)/step;return [px,py,sign===1?sw+(ne-nw)*u+(nw-sw)*v:sw+(se-sw)*u+(ne-se)*v];});
    }
  }
}
