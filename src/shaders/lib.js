// Shared GLSL: header, hashes, noise, SDF primitives, camera.
window.SH = window.SH || {};

SH.header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
out vec4 fragColor;
#define PI 3.14159265359
#define TAU 6.28318530718
`;

SH.noise = `
float sat(float x){ return clamp(x,0.,1.); }
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,s,-s,c); }
float hash11(float p){ p=fract(p*.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p3){ p3=fract(p3*.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3 hash33(vec3 p3){ p3=fract(p3*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
float noise(vec2 x){ vec2 i=floor(x), f=fract(x); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float noise3(vec3 x){ vec3 i=floor(x), f=fract(x); vec3 u=f*f*(3.-2.*f);
  float a=hash13(i), b=hash13(i+vec3(1,0,0)), c=hash13(i+vec3(0,1,0)), d=hash13(i+vec3(1,1,0));
  float e=hash13(i+vec3(0,0,1)), g=hash13(i+vec3(1,0,1)), h=hash13(i+vec3(0,1,1)), k=hash13(i+vec3(1,1,1));
  return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y), mix(mix(e,g,u.x),mix(h,k,u.x),u.y), u.z); }
vec3 noised(vec2 x){ vec2 i=floor(x), f=fract(x);
  vec2 u=f*f*f*(f*(f*6.-15.)+10.); vec2 du=30.*f*f*(f*(f-2.)+1.);
  float a=hash12(i), b=hash12(i+vec2(1,0)), c=hash12(i+vec2(0,1)), d=hash12(i+vec2(1,1));
  float k1=b-a, k2=c-a, k4=a-b-c+d;
  return vec3(-1.+2.*(a+k1*u.x+k2*u.y+k4*u.x*u.y), 2.*du*vec2(k1+k4*u.y, k2+k4*u.x)); }
const mat2 M2 = mat2(1.6,-1.2,1.2,1.6);
float fbm(vec2 p){ float f=0., a=0.5; for(int i=0;i<5;i++){ f+=a*noise(p); p=M2*p; a*=0.5; } return f/0.96875; }
float fbm3(vec3 p){ float f=0., a=0.5; for(int i=0;i<5;i++){ f+=a*noise3(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return f/0.96875; }
float fbmE(vec2 p, int oct){ float a=0., b=0.5; vec2 d=vec2(0);
  for(int i=0;i<12;i++){ if(i>=oct) break; vec3 n=noised(p); d+=n.yz; a+=b*n.x/(1.+dot(d,d)); b*=0.5; p=M2*p; } return a; }
// Voronoi edge distance (for cracks)
float voronoiEdge(vec2 x){
  vec2 n=floor(x), f=fract(x); vec2 mg, mr; float md=8.;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g=vec2(i,j); vec2 o=hash22(n+g); vec2 r=g+o-f; float d=dot(r,r); if(d<md){ md=d; mr=r; mg=g; } }
  md=8.;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){ vec2 g=mg+vec2(i,j); vec2 o=hash22(n+g); vec2 r=g+o-f;
    if(dot(mr-r,mr-r)>0.00001) md=min(md, dot(0.5*(mr+r), normalize(r-mr))); }
  return md;
}
`;

SH.sdf = `
float sdBox(vec3 p, vec3 b){ vec3 q=abs(p)-b; return length(max(q,0.))+min(max(q.x,max(q.y,q.z)),0.); }
float sdBox2(vec2 p, vec2 b){ vec2 q=abs(p)-b; return length(max(q,0.))+min(max(q.x,q.y),0.); }
float sdCyl(vec3 p, float r, float h){ vec2 d=abs(vec2(length(p.xz),p.y))-vec2(r,h); return min(max(d.x,d.y),0.)+length(max(d,0.)); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r){ vec3 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.); return length(pa-ba*h)-r; }
float sdCapsule2(vec3 p, vec3 a, vec3 b, float ra, float rb){ vec3 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.,1.); return length(pa-ba*h)-mix(ra,rb,h); }
float sdEllipsoid(vec3 p, vec3 r){ float k0=length(p/r); float k1=length(p/(r*r)); return k0*(k0-1.)/k1; }
// ring lying in xz-plane (axis y), rectangular section: hs.x radial half-thickness, hs.y axial half-width
float sdRing(vec3 p, float R, vec2 hs){ vec2 q=vec2(length(p.xz)-R, p.y); return sdBox2(q, hs-0.3)-0.3; }
float smin(float a, float b, float k){ float h=max(k-abs(a-b),0.)/k; return min(a,b)-h*h*k*0.25; }
`;

SH.camera = `
uniform vec2 uRes;
uniform float uTime, uShotT;
uniform vec3 uCamPos, uCamTar;
uniform float uFov, uRoll;
vec3 camRay(vec2 fc){
  vec2 uv=(2.*fc-uRes)/uRes.y;
  vec3 f=normalize(uCamTar-uCamPos);
  vec3 r0=normalize(cross(f, vec3(0,1,0))); vec3 u0=cross(r0,f);
  float cr=cos(uRoll), sr=sin(uRoll);
  vec3 r=cr*r0+sr*u0; vec3 u=cross(r,f);
  float fl=1./tan(radians(uFov)*0.5);
  return normalize(uv.x*r+uv.y*u+fl*f);
}
float pixelAngle(){ return 2.*tan(radians(uFov)*0.5)/uRes.y; }
`;
