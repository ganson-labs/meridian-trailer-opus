// World shader: one skeleton, three worlds (TWILIGHT / DESERT / ICE) selected by #define.
window.SH = window.SH || {};

SH.worldUniforms = `
uniform vec4 uA, uB, uC, uD;
uniform vec4 uCloud;          // x coverage, y altitude, z offset, w opacity
uniform vec4 uFog;            // x density, y falloff, z sun scatter, w particles
uniform vec3 uTravPos;
uniform vec4 uTrav;           // x facing, y phase, z gait, w mode (0 hidden, 1 ground, 2 explicit y)
uniform vec3 uLanternOff;
uniform float uLanternI;
uniform float uAmbK;
uniform float uFlash;
uniform vec3 uFlashCol;
uniform float uHeat;
float gMat;
float gTravY;
vec3 gLanW;
const vec3 LANCOL = vec3(1.0,0.55,0.2);
void U(inout float d, float nd, float m){ if(nd<d){ d=nd; gMat=m; } }
`;

// ------------------------------------------------------------------ traveler
SH.traveler = `
vec3 travLocal(vec3 pw){ vec3 p=pw-vec3(uTravPos.x,gTravY,uTravPos.z); p.xz=rot(uTrav.x)*p.xz; return p; }
vec3 lanternWorld(){
  vec3 l=uLanternOff; float g=uTrav.z;
  l.y+=(abs(sin(uTrav.y))-0.5)*0.06*min(g,1.5);
  vec2 xz=rot(-uTrav.x)*l.xz;
  return vec3(uTravPos.x+xz.x, gTravY+l.y, uTravPos.z+xz.y);
}
float traveler(vec3 pw){
  if(uTrav.w<0.5) return 1e9;
  vec3 p=travLocal(pw);
  float bound=length(p-vec3(0.,1.,-0.5))-2.4;
  if(bound>0.3) return bound;
  float ph=uTrav.y, g=uTrav.z;
  p.y-=(abs(sin(ph))-0.5)*0.06*min(g,1.5);
  vec3 q=p; q.zy=rot(0.03*g+0.1*max(g-1.,0.))*q.zy;
  float d=1e9;
  // head & hood
  float head=length(q-vec3(0.,1.62,0.04))-0.1;
  float hood=sdEllipsoid(q-vec3(0.,1.66,-0.01), vec3(0.15,0.17,0.17));
  hood=max(hood,-sdEllipsoid(q-vec3(0.,1.61,0.14), vec3(0.095,0.115,0.1)));
  hood=smin(hood, sdCapsule2(q, vec3(0.,1.73,-0.09), vec3(0.015*sin(uTime*4.),1.6+0.02*sin(uTime*5.),-0.25-0.05*g), 0.075, 0.02), 0.06);
  U(d, head, 7.);
  U(d, hood, 4.);
  // cloak
  float y=q.y; float k=sat((1.5-y)/1.26);
  vec3 cq=q;
  cq.z+=k*k*(0.16*g+0.06*sin(uTime*6.+y*6.));
  cq.x+=k*k*0.05*sin(uTime*4.3+y*4.);
  float ang=atan(cq.x,cq.z);
  float rad=mix(0.16,0.42+0.08*g,k)+0.025*k*sin(ang*6.+uTime*5.+y*3.);
  float cloak=(length(cq.xz*vec2(1.,1.15))-rad)*0.8;
  cloak=max(cloak, y-1.52);
  cloak=max(cloak, 0.3+0.06*sin(ang*5.+uTime*6.)+0.1*g*sat(-cq.z*3.)-y);
  cloak=smin(cloak, sdEllipsoid(q-vec3(0.,1.38,0.), vec3(0.24,0.13,0.17)), 0.08);
  U(d, cloak, 4.);
  // legs
  float gg=min(g,1.6);
  vec3 hL=vec3(0.09,0.82,0.), hR=vec3(-0.09,0.82,0.);
  vec3 fL=hL+vec3(0.,-0.78+max(0.,sin(ph))*0.16*gg, 0.36*sin(ph)*gg);
  vec3 fR=hR+vec3(0.,-0.78+max(0.,-sin(ph))*0.16*gg,-0.36*sin(ph)*gg);
  U(d, min(sdCapsule(q,hL,fL,0.055), sdCapsule(q,hR,fR,0.055)), 7.);
  // right arm -> lantern, left arm -> staff
  vec3 lan=uLanternOff;
  U(d, sdCapsule(q, vec3(-0.2,1.4,0.02), lan+vec3(0.,0.13,-0.02), 0.045), 4.);
  vec3 sb=vec3(0.32,0.02,0.22+0.1*sin(ph)*gg), st=vec3(0.3,1.95,0.16+0.05*sin(ph)*gg);
  U(d, sdCapsule(q, sb, st, 0.022), 7.);
  U(d, sdCapsule(q, vec3(0.2,1.4,0.02), mix(sb,st,0.62), 0.045), 4.);
  // scarf
  vec3 s0=vec3(0.,1.44,-0.1); float sc=1e9;
  for(int i=0;i<6;i++){
    float fi=float(i);
    float w=sin(uTime*(8.+2.*g)-fi*1.1);
    vec3 s1=s0+vec3(0.04*(fi+1.)*cos(uTime*5.-fi*0.9), -0.085+0.012*g+0.02*(fi+1.)*w, -0.085-0.03*g);
    sc=min(sc, sdCapsule2(q, s0, s1, 0.042-fi*0.005, 0.038-fi*0.005));
    s0=s1;
  }
  U(d, sc, 5.);
  // lantern
  float lb=sdCapsule(q, lan-vec3(0.,0.06,0.), lan+vec3(0.,0.05,0.), 0.055);
  U(d, lb, 6.);
  return d;
}
`;

// ------------------------------------------------------------------ TWILIGHT world
SH.twilight = `
#define HMAX 135.
#define FARCLIP 6000.
#define HAS_WATER 1
#define LO_OCT 5
#define HI_OCT 9
const vec3 RC=vec3(0.,96.,0.);
float coastD(vec2 p){ return p.x-178.-40.*sin(p.y*0.0045+1.)-30.*(noise(p*0.012)-0.5); }
float terrainH(vec2 p, int oct){
  float n=fbmE(p*0.0032, oct);
  float h=34.+55.*n+45.*smoothstep(0.,1.,-p.x/1200.);
  float r=length(p);
  h=mix(38.+1.2*n, h, smoothstep(135.,240.,r));
  float c=coastD(p);
  h=mix(h, -24.+10.*n, smoothstep(-24.,14.,c));
  return h;
}
float glyph(vec2 uv, float id){
  vec2 g=(uv-vec2(0.14,0.1))/vec2(0.72,0.8);
  if(g.x<0.||g.x>1.||g.y<0.||g.y>1.) return 0.;
  float d=1e9;
  for(int k=0;k<5;k++){
    vec2 a=floor(hash22(vec2(id,float(k)*7.1))*3.)/2.;
    vec2 b=floor(hash22(vec2(float(k)*3.3,id+11.))*3.)/2.;
    vec2 pa=g-a, ba=b-a; float t=clamp(dot(pa,ba)/max(dot(ba,ba),1e-4),0.,1.);
    d=min(d, length(pa-ba*t));
  }
  if(hash11(id*1.7)>0.6) d=min(d, abs(length(g-0.5)-0.3));
  return smoothstep(0.09,0.04,d);
}
float armillary(vec3 pw){
  vec3 p=pw-RC;
  float bound=length(p-vec3(0.,-25.,0.))-86.;
  if(bound>2.) return bound;
  float d=1e9;
  // ring A: plane yz, axis x, fixed
  float dA=sdRing(vec3(p.y,p.x,p.z), 50., vec2(3.4,2.8));
  float r=length(p.yz); float an=atan(p.z,p.y); float sec=TAU/64.; float ai=floor(an/sec+0.5); float al=an-ai*sec;
  vec2 lp=vec2(r*cos(al)-54.3, r*sin(al));
  dA=min(dA, max(sdBox2(lp, vec2(1.0,1.05))-0.1, abs(p.x)-2.1));
  U(d, dA, 1.);
  // ring B: spins about world y
  vec3 pb=p; pb.xz=rot(uB.x)*pb.xz;
  float dB=sdRing(vec3(pb.y,pb.x,pb.z), 42.8, vec2(2.4,2.1));
  dB=min(dB, sdCyl(vec3(p.x,abs(p.y)-45.8,p.z), 1.8, 1.7));
  U(d, dB, 2.);
  // ring C: spins about B-local z
  vec3 pc=pb; pc.xy=rot(uB.y)*pc.xy;
  float dC=sdRing(pc, 36., vec2(2.0,1.8));
  dC=min(dC, sdCyl(vec3(pb.x,abs(pb.z)-39.3,pb.y), 1.4, 1.6));
  dC=min(dC, sdRing(pc, 10.4, vec2(0.6,0.9)));
  U(d, dC, 2.);
  // core
  U(d, length(p)-9., 3.);
  // pylons
  vec3 pp=vec3(p.x, pw.y-51., abs(p.z)-34.);
  float w=1.-0.014*(pp.y+7.);
  U(d, sdBox(pp, vec3(6.5*w,7.6,5.5*w))-0.5, 1.);
  // base discs
  vec3 q=pw-vec3(0.,38.,0.);
  float dBase=sdCyl(q-vec3(0.,-3.,0.), 64., 5.);
  dBase=min(dBase, sdCyl(q-vec3(0.,3.,0.), 56., 1.));
  dBase=min(dBase, sdCyl(q-vec3(0.,5.,0.), 48., 1.));
  // stairs on -x
  vec3 sp=pw-vec3(-55.,38.,0.);
  float stepH=0.3*(floor((sp.x+11.)/1.1)+1.);
  dBase=min(dBase, max(sdBox(sp-vec3(0.,3.,0.), vec3(11.,3.,4.)), (sp.y-min(stepH,6.))*0.7));
  U(d, dBase, 1.);
  return d;
}
float menhirs(vec3 pw){
  float r=length(pw.xz);
  float b=max(abs(r-118.)-9., pw.y-56.);
  if(b>2.) return b;
  float n=13.; float an=atan(pw.z,pw.x); float sec=TAU/n; float id=floor(an/sec+0.5); float a=an-id*sec;
  vec3 q=vec3(r*cos(a)-118., pw.y-38., r*sin(a));
  float h1=hash11(id*7.3+1.);
  float hh=6.+7.*h1;
  q.xy=rot(0.12*(h1-0.5))*q.xy;
  float d=sdBox(q-vec3(0.,hh*0.5-1.,0.), vec3(1.2+0.4*h1, hh*0.5, 1.9))-0.35;
  d=max(d, dot(q-vec3(0.,hh-1.6,0.), normalize(vec3(0.4*(h1-0.5),1.,0.6*(hash11(id)-0.5)))));
  return d;
}
float mapObj(vec3 p){
  float d=1e9;
  U(d, armillary(p), gMat);
  float dm=menhirs(p); if(dm<d){ d=dm; gMat=1.; }
  float m0=gMat; float dt=traveler(p); if(dt<d){ d=dt; } else gMat=m0;
  return d;
}
vec3 terrainAlbedo(vec3 p, inout vec3 n, float t){
  float v=noise(p.xz*0.05), v2=noise(p.xz*0.4);
  vec3 grass=mix(vec3(0.19,0.2,0.07), vec3(0.34,0.3,0.13), v)*(0.8+0.3*v2);
  vec3 rock=mix(vec3(0.2,0.18,0.16), vec3(0.34,0.3,0.26), noise(p.xz*0.12+p.y*0.3))*(0.85+0.3*v2);
  vec3 c=mix(rock, grass, smoothstep(0.7,0.86,n.y));
  c=mix(vec3(0.5,0.44,0.34), c, smoothstep(1.,4.,p.y));
  // worn path around the machine
  float pr=length(p.xz);
  c=mix(c, vec3(0.36,0.31,0.24), 0.5*smoothstep(8.,0.,abs(pr-92.))*smoothstep(0.85,0.95,n.y));
  return c;
}
vec3 terrainEmissive(vec3 p){
  if(uC.x<0.) return vec3(0.);
  float r=uC.x*420.;
  float w=abs(length(p.xz)-r);
  return vec3(1.,0.75,0.45)*exp(-w*0.12)*exp(-uC.x*1.4)*6.;
}
`;

// ------------------------------------------------------------------ DESERT world
SH.desert = `
#define HMAX 70.
#define FARCLIP 5000.
#define LO_OCT 4
#define HI_OCT 7
float duneP(float x){ float f=fract(x); return f<0.78 ? pow(f/0.78,1.35) : 1.-smoothstep(0.,1.,(f-0.78)/0.22); }
float terrainH(vec2 p, int oct){
  vec2 w=vec2(noise(p*0.0021), noise(p*0.0023+17.))-0.5;
  vec2 q=p+w*180.;
  float d1=duneP(q.x/210.+0.22*sin(q.y*0.0065));
  vec2 r=mat2(0.87,0.5,-0.5,0.87)*p+w*60.;
  float d2=duneP(r.x/62.+0.3*sin(r.y*0.021));
  float base=22.*fbmE(p*0.0016, min(oct,4));
  float amp=0.55+0.45*noise(p*0.003+5.);
  return base+28.*d1*amp+4.5*d2*(1.-0.5*d1);
}
float gearRing(vec3 q, float R, vec2 hs, float nt){
  float d=sdRing(vec3(q.x,q.z,q.y), R, hs);
  float r=length(q.xy); float an=atan(q.y,q.x); float sec=TAU/nt; float ai=floor(an/sec+0.5); float al=an-ai*sec;
  vec2 lp=vec2(r*cos(al)-(R+hs.x+1.4), r*sin(al));
  float broken=step(0.82, hash11(ai+R));
  d=min(d, max(sdBox2(lp, vec2(1.5,1.6))+broken*9., abs(q.z)-hs.y*0.75));
  return d;
}
float mapObj(vec3 p){
  float d=1e9;
  // colossal half-buried ring
  vec3 q=p-vec3(40.,6.,900.);
  if(length(q)<150.){
    q.yz=rot(0.33)*q.yz; q.xy=rot(0.18)*q.xy;
    U(d, gearRing(q, 118., vec2(7.,5.5), 72.), 1.);
  } else U(d, length(q)-140., 1.);
  // far ring lying on its side
  vec3 q2=p-vec3(-720.,-30.,1700.);
  if(length(q2)<120.){ q2.yz=rot(1.25)*q2.yz; q2.xy=rot(-0.3)*q2.xy; U(d, gearRing(q2, 85., vec2(5.,4.), 56.), 1.); }
  else U(d, length(q2)-110., 1.);
  // leaning obelisks
  for(int i=0;i<3;i++){
    vec3 c = i==0 ? vec3(38.,-18.,210.) : (i==1 ? vec3(-75.,-20.,360.) : vec3(120.,-22.,470.));
    vec3 o=p-c;
    float a = i==0 ? 0.28 : (i==1 ? -0.2 : 0.12);
    o.xy=rot(a)*o.xy; o.zy=rot(0.12*float(i)-0.1)*o.zy;
    float ob=sdBox(o-vec3(0.,22.,0.), vec3(2.6,26.,2.6))-0.3;
    ob=max(ob, dot(o-vec3(0.,47.,0.), normalize(vec3(0.5,1.,0.3))));
    U(d, ob, 1.);
  }
  float m0=gMat; float dt=traveler(p); if(dt<d) d=dt; else gMat=m0;
  return d;
}
vec3 terrainAlbedo(vec3 p, inout vec3 n, float t){
  float fade=1.-smoothstep(15.,140.,t);
  if(fade>0.){
    vec2 q=p.xz;
    float ph=q.x*2.2+0.9*sin(q.y*0.33)+1.8*noise(q*0.25);
    float s=cos(ph);
    n=normalize(n+vec3(-s*0.16*fade*n.y, 0., -0.3*s*0.16*fade*n.y*0.3));
  }
  float v=noise(p.xz*0.02);
  vec3 c=mix(vec3(0.8,0.47,0.24), vec3(0.9,0.62,0.36), v);
  c=mix(c, vec3(0.6,0.34,0.18), 0.4*smoothstep(0.3,0.9,1.-n.y));
  return c*0.8;
}
vec3 terrainEmissive(vec3 p){ return vec3(0.); }
`;

// ------------------------------------------------------------------ ICE world
SH.ice = `
#define HMAX 520.
#define FARCLIP 7000.
#define HAS_WATER 1
#define ICE_SURFACE 1
#define LO_OCT 6
#define HI_OCT 10
float terrainH(vec2 p, int oct){
  float m=smoothstep(250.,1300.,p.y+0.25*abs(p.x));
  if(m<=0.) return -30.;
  vec2 q=p*0.0011+vec2(3.1,7.7);
  float base=fbmE(q*0.8, min(oct,5));
  float h=0., a=0.5; vec2 r=q*1.6;
  for(int i=0;i<10;i++){ if(i>=oct) break; float n=1.-abs(noised(r).x); h+=a*n*n*n; a*=0.4; r=M2*r; }
  return mix(-30., 230.*base+380.*h-40., m);
}
float titan(vec3 pw){
  float S=uC.z;
  vec3 p=(pw-vec3(uD.z,uC.w,1350.))/S;
  float bound=length(p-vec3(0.,2.8,0.))-3.4;
  if(bound>0.4) return bound*S;
  p.x=abs(p.x);
  float body=sdEllipsoid(p-vec3(0.,2.3,0.1), vec3(1.0,1.45,0.75));
  float chest=sdEllipsoid(p-vec3(0.,3.15,-0.02), vec3(1.4,0.72,0.8));
  float head=sdEllipsoid(p-vec3(0.,3.98,-0.38), vec3(0.4,0.44,0.48));
  float jaw=sdEllipsoid(p-vec3(0.,3.78,-0.62), vec3(0.28,0.2,0.3));
  float d=smin(body,chest,0.45);
  d=smin(d,head,0.3); d=smin(d,jaw,0.12);
  // horns
  float hn=min(sdCapsule2(p, vec3(0.26,4.22,-0.35), vec3(0.72,4.62,-0.15), 0.13, 0.1),
               sdCapsule2(p, vec3(0.72,4.62,-0.15), vec3(0.98,5.25,0.12), 0.1, 0.065));
  hn=min(hn, sdCapsule2(p, vec3(0.98,5.25,0.12), vec3(0.86,5.85,0.45), 0.065, 0.02));
  d=min(d,hn);
  // arms & legs
  d=smin(d, sdCapsule2(p, vec3(1.3,3.2,0.), vec3(1.65,1.7,-0.35), 0.36, 0.28), 0.2);
  d=smin(d, sdCapsule2(p, vec3(1.65,1.7,-0.35), vec3(1.55,0.25,-0.6), 0.28, 0.22), 0.1);
  d=smin(d, sdCapsule2(p, vec3(0.5,1.3,0.1), vec3(0.62,-0.6,0.1), 0.42, 0.34), 0.2);
  // spines along the back
  float sp=sdCapsule2(p, vec3(0.,3.4,0.55), vec3(0.,4.2,0.95), 0.1, 0.01);
  d=min(d,sp);
  return d*S;
}
vec3 eyePos(float s){ return vec3(uD.z,uC.w,1350.)+uC.z*vec3(0.155*s,4.03,-0.83); }
float mapObj(vec3 p){
  float d=1e9;
  U(d, titan(p), 8.);
  float m0=gMat; float dt=traveler(p); if(dt<d) d=dt; else gMat=m0;
  return d;
}
vec3 terrainAlbedo(vec3 p, inout vec3 n, float t){
  float snow=smoothstep(0.55,0.75,n.y+0.15*noise(p.xz*0.03));
  vec3 rock=vec3(0.13,0.14,0.16)*(0.7+0.5*noise(p.xz*0.08+p.y*0.05));
  return mix(rock, vec3(0.82,0.87,0.95), snow);
}
vec3 terrainEmissive(vec3 p){ return vec3(0.); }
vec3 aurora(vec3 ro, vec3 rd){
  if(rd.y<0.01) return vec3(0.);
  vec3 acc=vec3(0.);
  float jit=hash12(gl_FragCoord.xy+fract(uTime)*50.)*0.5;
  for(int i=0;i<34;i++){
    float fi=float(i)+jit;
    float h=1.+fi*0.075;
    vec2 p=rd.xz*(h/rd.y);
    vec2 q=p*0.33+vec2(0.,1.2);
    float w=fbm(q*vec2(0.9,0.55)+vec2(uTime*0.025,-uTime*0.01));
    float line=exp(-abs(w-0.52)*34.);
    float rays=0.55+0.45*noise(vec2(q.x*26.+q.y*9.+uTime*0.6, fi*0.05));
    float inten=line*rays*exp(-fi*0.085);
    vec3 c=mix(vec3(0.15,1.,0.5), vec3(0.55,0.2,1.), smoothstep(5.,28.,fi));
    acc+=c*inten;
  }
  return acc*0.055*smoothstep(0.01,0.2,rd.y);
}
float bolt(vec3 ro, vec3 rd){
  if(uC.y<=0.) return 0.;
  float zb=1700.;
  if(rd.z<=0.) return 0.;
  float t=(zb-ro.z)/rd.z; vec3 p=ro+rd*t;
  float x0=uD.z-260.+uC.y*0.;
  float y=p.y;
  if(y<150.||y>1400.) return 0.;
  float xb=x0+60.*(noise(vec2(y*0.012,uD.w))-0.5)*2.+22.*(noise(vec2(y*0.05,uD.w+3.))-0.5)*2.;
  float d=abs(p.x-xb);
  float br=x0+(y-900.)*0.35+30.*(noise(vec2(y*0.03,uD.w+7.))-0.5);
  float d2=y<900.&&y>520. ? abs(p.x-br) : 1e9;
  float w=2.5+t*0.0012;
  return exp(-d*d/(w*w))*4.+exp(-d*d/(w*w*60.))*0.5 + (exp(-d2*d2/(w*w))*2.)*smoothstep(520.,700.,y);
}
`;

// ------------------------------------------------------------------ generic skeleton
SH.worldMain = `
float marchTerrain(vec3 ro, vec3 rd, float tmax){
  float t=0.2;
  if(ro.y>HMAX){ if(rd.y>=0.) return 1e9; t=max(t,(ro.y-HMAX)/-rd.y); }
  float lt=t, ld=0.;
  for(int i=0;i<300;i++){
    vec3 p=ro+rd*t;
    float d=p.y-terrainH(p.xz, LO_OCT);
    if(d<0.0015*t){ if(i>0) t=lt+(t-lt)*ld/max(ld-d,1e-4); return t; }
    if(t>tmax || (p.y>HMAX && rd.y>0.)) break;
    lt=t; ld=d;
    t+=max(0.42*d, 0.0008*t);
  }
  return 1e9;
}
vec3 terrainNormal(vec2 p, float t){
  float e=max(0.03, 0.0015*t);
  float h=terrainH(p, HI_OCT);
  return normalize(vec3(h-terrainH(p+vec2(e,0.),HI_OCT), e, h-terrainH(p+vec2(0.,e),HI_OCT)));
}
float terrainShadow(vec3 ro, vec3 rd){
  float res=1., t=0.5;
  for(int i=0;i<72;i++){
    vec3 p=ro+rd*t;
    float h=p.y-terrainH(p.xz, 4);
    res=min(res, 10.*h/t);
    t+=clamp(h*0.7, 0.8, 60.);
    if(res<0.002 || (p.y>HMAX && rd.y>0.) || t>4000.) break;
  }
  return smoothstep(0.,1.,sat(res));
}
float marchObj(vec3 ro, vec3 rd, float tmax){
  float t=0.05;
  for(int i=0;i<200;i++){
    float h=mapObj(ro+rd*t);
    if(abs(h)<0.0004*t+0.0008) return t;
    t+=h*0.9;
    if(t>tmax) break;
  }
  return 1e9;
}
vec3 objNormal(vec3 p, float t){
  float e=0.0004*t+0.002;
  vec2 k=vec2(1.,-1.);
  return normalize(k.xyy*mapObj(p+k.xyy*e)+k.yyx*mapObj(p+k.yyx*e)+k.yxy*mapObj(p+k.yxy*e)+k.xxx*mapObj(p+k.xxx*e));
}
float objShadow(vec3 ro, vec3 rd){
  float res=1., t=0.15;
  for(int i=0;i<80;i++){
    float h=mapObj(ro+rd*t);
    res=min(res, 10.*h/t);
    t+=clamp(h, 0.08, 40.);
    if(res<0.003 || t>2000.) break;
  }
  return sat(res);
}
float objAO(vec3 p, vec3 n, float sc){
  float o=0., w=1.;
  for(int i=1;i<=5;i++){ float h=sc*float(i)*0.12; o+=w*(h-mapObj(p+n*h)); w*=0.6; }
  return sat(1.-o/sc*1.6);
}
vec3 lanternLight(vec3 p, vec3 n){
  if(uLanternI<=0.) return vec3(0.);
  vec3 L=gLanW-p; float d2=dot(L,L);
  return LANCOL*uLanternI*max(dot(n,L*inversesqrt(d2)),0.)/(d2+0.25);
}
vec3 ambientAt(vec3 n){
  vec3 up=skyL(vec3(0.,1.,0.));
  vec2 sd=normalize(uSunDir.xz+1e-5);
  vec3 hz=skyL(normalize(vec3(sd.x,0.45,sd.y)));
  vec3 hzo=skyL(normalize(vec3(-sd.x,0.3,-sd.y)));
  float side=dot(n.xz, sd);
  return (up*(0.6+0.4*n.y) + hz*0.25*max(side,0.) + hzo*0.3*max(-side,0.))*1.5*uAmbK;
}
vec4 clouds(vec3 ro, vec3 rd){
  if(uCloud.w<=0. || rd.y<0.004) return vec4(0.);
  float H=uCloud.y;
  float t=(H-ro.y)/rd.y; vec3 p=ro+rd*t;
  vec2 uv=p.xz*0.00032+vec2(uCloud.z, uCloud.z*0.35);
  float den0=fbm(uv);
  float cov=uCloud.x;
  float den=smoothstep(1.-cov, 1.-cov+0.28, den0);
  if(den<=0.) return vec4(0.);
  den*=0.75+0.25*fbm(uv*4.+3.);
  float d2=fbm(uv+normalize(uSunDir.xz+1e-4)*0.06);
  float lit=sat(0.55+(den0-d2)*4.);
  float mu=dot(rd,uSunDir);
  float ph=0.6+1.6*pow(max(mu,0.),5.)+0.4*pow(max(mu,0.),40.);
  vec3 amb=skyL(vec3(0.,1.,0.))*2.2+skyL(normalize(vec3(rd.x,0.05,rd.z)))*0.8;
  float sunUnder=smoothstep(0.12,-0.02,uSunDir.y);
  vec3 c=amb*(0.55+0.45*(1.-den)) + uSunCol*(lit*ph*0.45+sunUnder*0.25*(1.-den)) + uMoonCol*0.2*lit + uFlashCol*uFlash*0.9*(0.5+0.5*den0);
  float fade=exp(-t*0.000055);
  return vec4(c, sat(den*1.4)*fade*uCloud.w);
}
vec3 skyColor(vec3 ro, vec3 rd){
  vec3 c=skyL(rd);
  float bright=dot(c, vec3(0.3,0.5,0.2));
  if(uNight>0.) c+=stars(rd)*uNight*sat(1.-bright*6.);
  c+=moonDisc(rd, 1.3);
  c+=sunDisc(rd, SUN_SIZE);
#ifdef ICE_SURFACE
  c+=aurora(ro, rd)*uA.x;
  c+=vec3(0.75,0.8,1.)*bolt(ro, rd)*uC.y;
#endif
  vec4 cl=clouds(ro, rd);
  c=mix(c, cl.rgb, cl.a);
  c+=uFlashCol*uFlash*0.25*(1.-cl.a*0.5);
  return c;
}
vec3 applyFog(vec3 col, float t, vec3 ro, vec3 rd){
  float b=uFog.x, c=uFog.y;
  float k=rd.y*c;
  float path = abs(k)<1e-5 ? t : (1.-exp(-t*k))/k;
  float amt=1.-exp(-b*exp(-ro.y*c)*path);
  vec3 fc=skyL(normalize(vec3(rd.x, max(rd.y,0.04), rd.z)));
  fc+=uSunCol*pow(max(dot(rd,uSunDir),0.),8.)*uFog.z;
  fc*=1.2/(1.2+dot(fc,vec3(0.3,0.5,0.2)));
  fc+=uFlashCol*uFlash*0.3;
  return mix(col, fc, amt);
}
vec3 shadeTerrain(vec3 p, vec3 rd, float t){
  vec3 n=terrainNormal(p.xz, t);
  vec3 alb=terrainAlbedo(p, n, t);
  vec3 L=uSunDir;
  float dif=max(dot(n,L),0.);
  float sh=0.;
  if(dif>0.001 && L.y>-0.05) sh=min(terrainShadow(p+n*0.3, L), objShadow(p+n*0.5, L));
  vec3 col=alb*(uSunCol*dif*sh + ambientAt(n) + uMoonCol*max(dot(n,uMoonDir),0.)*0.9 + uFlashCol*uFlash*0.18*(0.3+0.7*max(n.y,0.)));
#ifndef ICE_SURFACE
  vec3 hv=normalize(L-rd);
  col+=uSunCol*sh*pow(max(dot(n,hv),0.),40.)*0.05*dif;
#endif
#ifdef ICE_SURFACE
  vec3 hv=normalize(uMoonDir-rd);
  col+=uMoonCol*pow(max(dot(n,hv),0.),60.)*0.6*smoothstep(0.6,0.8,n.y);
#endif
  col+=alb*lanternLight(p, n);
  col+=terrainEmissive(p);
  return col;
}
vec3 shadeObj(vec3 p, vec3 rd, float t){
  mapObj(p); float m=gMat;
  vec3 n=objNormal(p, t);
  vec3 alb=vec3(0.3); float ks=0.04, shin=30.; vec3 emi=vec3(0.);
  float aoScale=6.;
  if(m<1.5){
    float v=fbm3(p*0.35)*0.6+0.4*noise3(p*2.1);
    alb=mix(vec3(0.13,0.12,0.11), vec3(0.3,0.27,0.23), v);
#ifdef WORLD_DESERT
    alb=mix(vec3(0.36,0.29,0.22), vec3(0.56,0.46,0.34), v);
#endif
#ifdef WORLD_TWILIGHT
    vec3 q=p-RC; float rr=length(q.yz);
    if(abs(rr-50.)<3.5 && abs(q.x)>2.2){
      float an=atan(q.z,q.y); float u=(an/TAU+0.5)*220.; float v2=(rr-47.)/6.;
      float row=floor(clamp(v2,0.,0.999)*2.);
      float id=floor(u)+row*977.;
      float g=glyph(vec2(fract(u),fract(v2*2.)), id);
      float foot=pixelAngle()*t/(TAU*50./220.);
      g=mix(g, 0.16, smoothstep(0.25,0.9,foot));
      float order=fract(an/TAU+0.5);
      float lit=max(uA.y, smoothstep(order, order+0.015, uA.z));
      alb*=1.-0.5*g;
      emi+=mix(vec3(1.,0.6,0.22), vec3(0.5,0.85,1.), 0.3+0.3*sin(an*3.+uTime))*g*(0.02+lit*(9.+4.*sin(uTime*6.+id)));
    }
#endif
  } else if(m<2.5){
    float v=fbm3(p*0.25);
    alb=mix(vec3(0.36,0.23,0.11), vec3(0.14,0.27,0.24), smoothstep(0.45,0.7,v));
    ks=0.35; shin=60.;
#ifdef WORLD_TWILIGHT
    vec3 q=p-RC;
    float seam=smoothstep(0.93,1.,abs(sin(atan(q.z,q.y)*40.)));
    emi+=vec3(1.,0.7,0.35)*seam*uA.y*4.;
#endif
  } else if(m<3.5){
#ifdef WORLD_TWILIGHT
    vec3 q=normalize(p-RC);
    vec2 sphUV=vec2(atan(q.z,q.x), acos(clamp(q.y,-1.,1.)))*vec2(3.,3.);
    float cr=voronoiEdge(sphUV*1.3+uTime*0.02*uA.y);
    float crack=smoothstep(0.09,0.01,cr);
    alb=vec3(0.06,0.055,0.05);
    float pulse=0.5+0.5*sin(uTime*2.2);
    emi=vec3(1.,0.42,0.12)*crack*(0.35+0.4*pulse+uA.y*30.) + vec3(1.,0.85,0.62)*uA.y*uA.y*55.;
#endif
  } else if(m<4.5){ alb=vec3(0.22,0.07,0.05); ks=0.02;
  } else if(m<5.5){ alb=vec3(0.75,0.1,0.05); ks=0.02;
  } else if(m<6.5){ alb=vec3(0.1); emi=LANCOL*uLanternI*1.6;
  } else if(m<7.5){ alb=vec3(0.12,0.1,0.09);
  } else {
    alb=vec3(0.035,0.035,0.04); ks=0.12; shin=20.; aoScale=60.;
#ifdef ICE_SURFACE
    for(int s=0;s<2;s++){
      vec3 e=eyePos(s==0?1.:-1.);
      vec3 dq=(p-e)/uC.z;
      float open=uD.x;
      vec2 el=vec2(dq.x/0.075, dq.y/(0.034*max(open,0.02)+0.0001));
      float r=length(el);
      float iris=smoothstep(1.05,0.9,r)*step(0.02,open);
      float pupil=smoothstep(0.012,0.004,abs(dq.x))*smoothstep(0.9,0.5,r);
      emi+=vec3(1.,0.45,0.08)*iris*(1.-0.85*pupil)*28.*open;
    }
#endif
  }
  vec3 L=uSunDir;
  float dif=max(dot(n,L),0.);
  float sh=0.;
  if(dif>0.001 && L.y>-0.05) sh=min(objShadow(p+n*0.1, L), terrainShadow(p+n*0.3, L));
  float ao=objAO(p, n, aoScale);
  vec3 hv=normalize(L-rd);
  vec3 col=alb*(uSunCol*dif*sh + ambientAt(n)*ao + uMoonCol*max(dot(n,uMoonDir),0.) + uFlashCol*uFlash*0.05*(0.25+0.4*max(n.y,0.))*ao);
  col+=uSunCol*sh*dif*ks*pow(max(dot(n,hv),0.),shin)*(shin*0.12);
  col+=alb*lanternLight(p, n)*ao;
  // rim from sky behind silhouettes
  col+=alb*skyL(normalize(vec3(rd.x,0.12,rd.z)))*pow(1.-max(dot(n,-rd),0.),4.)*0.18*ao;
  return col+emi;
}
#ifdef HAS_WATER
vec3 shadeWater(vec3 ro, vec3 rd, float t){
  vec3 p=ro+rd*t; vec2 q=p.xz;
  float fade=exp(-t*0.0015);
#ifdef ICE_SURFACE
  float cr=voronoiEdge(q*0.045);
  float cr2=voronoiEdge(q*0.21+7.);
  float snow=smoothstep(0.5,0.72,fbm(q*0.018)+0.1*noise(q*0.3));
  vec3 n=normalize(vec3((noise(q*0.6)-0.5)*0.04*fade,1.,(noise(q*0.6+9.)-0.5)*0.04*fade));
  float fres=0.04+0.96*pow(1.-max(dot(n,-rd),0.),5.);
  vec3 rr=reflect(rd,n);
  gStarK=0.2;
  vec3 refl=skyColor(p, rr);
  gStarK=1.;
  vec3 body=vec3(0.01,0.025,0.045)*(ambientAt(vec3(0.,1.,0.))+uMoonCol*0.5);
  vec3 c=mix(body, refl, sat(fres*1.6+0.08));
  float crack=smoothstep(0.035,0.0,cr)*0.8+smoothstep(0.02,0.0,cr2)*0.35;
  c+=vec3(0.5,0.65,0.8)*crack*(ambientAt(vec3(0.,1.,0.))*0.6+uMoonCol*0.4)*fade;
  vec3 salb=vec3(0.8,0.86,0.95);
  vec3 sc=salb*(ambientAt(vec3(0.,1.,0.))+uMoonCol*max(uMoonDir.y,0.)+uFlashCol*uFlash*0.8)+salb*lanternLight(p,vec3(0.,1.,0.));
  c=mix(c+lanternLight(p,vec3(0.,1.,0.))*0.05, sc, snow*0.85);
  c+=uFlashCol*uFlash*0.15*fres;
  return c;
#else
  vec2 g=vec2(0.); float a=1., fr=0.045; mat2 m=mat2(1.,0.,0.,1.);
  for(int i=0;i<6;i++){
    vec2 pp=m*q*fr+vec2(uTime*0.35,uTime*0.21)*(1.+0.35*float(i));
    vec3 nn=noised(pp);
    g+=a*fr*(transpose(m)*nn.yz);
    a*=0.52; fr*=2.05; m=mat2(0.8,-0.6,0.6,0.8)*m;
  }
  vec3 n=normalize(vec3(-g.x*1.6*fade, 1., -g.y*1.6*fade));
  float fres=0.02+0.98*pow(1.-max(dot(n,-rd),0.),5.);
  vec3 rr=reflect(rd,n); rr.y=abs(rr.y);
  float sh=1.;
  if(uSunDir.y>-0.05) sh=min(terrainShadow(p+vec3(0.,0.5,0.), uSunDir), objShadow(p+vec3(0.,0.5,0.), uSunDir));
  vec3 refl=skyL(rr);
  vec4 cl=clouds(p, rr); refl=mix(refl, cl.rgb, cl.a*0.8);
  refl+=stars(rr)*uNight*0.4;
  float mu=max(dot(rr,uSunDir),0.);
  vec3 spec=uSunCol*(pow(mu,1400.)*22.+pow(mu,160.)*1.2+pow(mu,24.)*0.12)*sh;
  vec3 body=vec3(0.008,0.03,0.04)*(ambientAt(vec3(0.,1.,0.))+uSunCol*0.25*max(uSunDir.y,0.));
  vec3 c=mix(body, refl, fres)+spec*fres*2.;
  float hT=terrainH(q, 4);
  float foam=smoothstep(-7.,0.,hT)*smoothstep(0.35,0.8,noise(q*0.25+vec2(uTime*0.3,0.))+0.5*sin(hT*1.2-uTime*1.6));
  foam+=0.25*smoothstep(0.8,1.,noise(q*0.08+uTime*0.05))*fade;
  vec3 fcol=vec3(0.85,0.9,0.92)*(ambientAt(vec3(0.,1.,0.))+uSunCol*max(uSunDir.y,0.)*sh);
  c=mix(c, fcol, sat(foam));
  c+=terrainEmissive(p)*0.5;
  return c;
#endif
}
#endif
vec3 particles(vec3 ro, vec3 rd, float tmax, float dens, vec3 vel, float size, vec3 col){
  vec3 acc=vec3(0.);
  float pa=pixelAngle();
  for(int i=0;i<9;i++){
    float fi=float(i);
    float z=1.1*pow(1.5,fi);
    if(z>tmax) break;
    float cell=z*0.25;
    vec3 off=vel*uTime;
    vec3 p=ro+rd*z;
    vec3 id=floor((p-off)/cell);
    vec3 h=hash33(id+fi*13.1);
    if(h.x>dens) continue;
    vec3 c=(id+0.15+0.7*hash33(id*1.7+3.+fi))*cell+off;
    c+=vec3(sin(uTime*1.3+h.y*20.),0.,cos(uTime*1.1+h.z*20.))*cell*0.08;
    vec3 oc=c-ro; float tc=dot(oc,rd);
    if(tc<0.3||tc>tmax) continue;
    float dist=length(oc-rd*tc);
    float r=size*cell*(0.4+h.y);
    float w=max(r, pa*tc*0.8);
    acc+=col*exp(-dist*dist/(w*w))*(r*r)/(w*w)*(0.4+h.z)*smoothstep(0.3,1.5,tc);
  }
  return acc;
}
void main(){
  vec3 ro=uCamPos; vec3 rd=camRay(gl_FragCoord.xy);
  if(uHeat>0.){
    float hz=1.-smoothstep(0.,0.12,abs(rd.y-0.02));
    vec2 hn=vec2(noise(vec2(gl_FragCoord.x*0.018, gl_FragCoord.y*0.05-uTime*7.)), noise(vec2(gl_FragCoord.x*0.02+9., gl_FragCoord.y*0.06-uTime*6.)))-0.5;
    rd=normalize(rd+vec3(hn.x,hn.y,0.)*0.0022*uHeat*hz);
  }
  gTravY = uTrav.w>1.5 ? uTravPos.y : terrainH(uTravPos.xz, 7);
#ifdef HAS_WATER
  if(uTrav.w<1.5) gTravY=max(gTravY, 0.);
#endif
  gLanW = lanternWorld();
  float tT=marchTerrain(ro, rd, FARCLIP);
  float tW=1e9;
#ifdef HAS_WATER
  if(rd.y<0. && ro.y>0.) tW=-ro.y/rd.y;
#endif
  float tS=min(tT,tW);
  float tO=marchObj(ro, rd, min(tS, FARCLIP));
  float t=min(tS,tO);
  vec3 col;
  bool hit=t<FARCLIP;
  if(!hit){ col=skyColor(ro, rd); t=FARCLIP; }
  else {
    vec3 p=ro+rd*t;
    if(tO<tS) col=shadeObj(p, rd, t);
#ifdef HAS_WATER
    else if(tW<tT) col=shadeWater(ro, rd, tW);
#endif
    else col=shadeTerrain(p, rd, t);
    col=applyFog(col, t, ro, rd);
  }
  // lantern halo
  if(uLanternI>0.){
    vec3 oc=gLanW-ro; float tc=dot(oc,rd);
    if(tc>0. && tc<t+0.5){ float d=length(oc-rd*tc); col+=LANCOL*uLanternI*(0.012/(d*d+0.004)+0.08/(d*d+0.6))*0.25; }
  }
#ifdef WORLD_TWILIGHT
  // core halo + beam + shock ring
  {
    vec3 oc=RC-ro; float tc=dot(oc,rd);
    if(tc>0. && uA.y>0.){ float d=length(oc-rd*tc); float vis = tc<t+12. ? 1. : 0.25;
      col+=vec3(1.,0.72,0.4)*uA.y*(3.5/(1.+d*d*0.02)+0.4/(1.+d*0.03))*vis; }
    if(uA.w>0.){
      vec2 o=ro.xz, dd=rd.xz; float ddd=dot(dd,dd);
      float tb=ddd>1e-6 ? -dot(o,dd)/ddd : 0.;
      tb=clamp(tb, 0., t);
      vec3 pb=ro+rd*tb;
      float dist=length(pb.xz);
      float wdt=2.5+max(pb.y-96.,0.)*0.006;
      float above=smoothstep(92.,120.,pb.y)*(1.-smoothstep(4000.,9000.,pb.y));
      float flick=0.9+0.1*sin(uTime*30.+pb.y*0.05);
      col+=(vec3(1.,0.9,0.75)*exp(-dist*dist/(wdt*wdt))*6. + vec3(0.6,0.75,1.)*0.4*wdt/(dist+wdt))*above*uA.w*flick;
    }
    if(uC.x>=0. && uC.x<3.){
      float tp=(96.-ro.y)/rd.y;
      if(tp>0. && tp<t){ vec3 pp=ro+rd*tp; float w=abs(length(pp.xz)-uC.x*420.);
        col+=vec3(1.,0.8,0.6)*exp(-w*0.08)*exp(-uC.x*1.2)*3.; }
    }
  }
#endif
#ifdef ICE_SURFACE
  if(uD.x>0.){
    for(int s=0;s<2;s++){
      vec3 oc=eyePos(s==0?1.:-1.)-ro; float tc=dot(oc,rd);
      if(tc>0.){ float d=length(oc-rd*tc)/uC.z; col+=vec3(1.,0.45,0.08)*uD.x*(0.0009/(d*d+0.0004)+0.02/(d*d+0.05))*0.6; }
    }
  }
#endif
  if(uFog.w>0.){
#ifdef WORLD_DESERT
    col+=particles(ro, rd, t, uFog.w, vec3(9.,0.4,2.), 0.006, (uSunCol*0.6+ambientAt(vec3(0.,1.,0.))*0.5)*vec3(1.,0.8,0.6)*0.6);
#endif
#ifdef ICE_SURFACE
    col+=particles(ro, rd, t, uFog.w, vec3(2.5+uD.y*6.,-1.6-uD.y*2.,0.5), 0.022, (uMoonCol*0.8+ambientAt(vec3(0.,1.,0.))*0.9+LANCOL*uLanternI*0.03+uFlashCol*uFlash*0.4)*1.2);
#endif
#ifdef WORLD_TWILIGHT
    col+=particles(ro, rd, t, uFog.w, vec3(0.6,0.15,0.3), 0.012, uSunCol*0.25*(0.2+pow(max(dot(rd,uSunDir),0.),6.)*3.));
#endif
  }
  fragColor=vec4(max(col,0.), hit ? 0. : 1.);
}
`;

SH.buildWorld = function (kind) {
  const defs = { twilight: '#define WORLD_TWILIGHT 1\n#define SUN_SIZE 1.6\n', desert: '#define WORLD_DESERT 1\n#define SUN_SIZE 1.3\n', ice: '#define WORLD_ICE 1\n#define SUN_SIZE 1.0\n' }[kind];
  const body = { twilight: SH.twilight, desert: SH.desert, ice: SH.ice }[kind];
  return SH.header + defs + SH.noise + SH.sdf + SH.camera + SH.skyWorld + SH.worldUniforms + SH.traveler + body + SH.worldMain;
};

// Height probe: writes terrainH for a grid so JS can place cameras and characters.
SH.buildProbe = function (kind) {
  const defs = { twilight: '#define WORLD_TWILIGHT 1\n#define SUN_SIZE 1.\n', desert: '#define WORLD_DESERT 1\n#define SUN_SIZE 1.\n', ice: '#define WORLD_ICE 1\n#define SUN_SIZE 1.\n' }[kind];
  const body = { twilight: SH.twilight, desert: SH.desert, ice: SH.ice }[kind];
  return SH.header + defs + SH.noise + SH.sdf + SH.camera + SH.skyWorld + SH.worldUniforms + SH.traveler + body + `
uniform vec4 uBox; // x0, z0, x1, z1
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5)/(uRes-1.);
  vec2 p=mix(uBox.xy, uBox.zw, uv);
  fragColor=vec4(terrainH(p, 8), 0., 0., 1.);
}`;
};
