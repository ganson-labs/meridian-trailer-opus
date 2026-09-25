// Atmosphere: sky-view LUT pass (single scattering, Rayleigh + Mie) and sky helpers for world shaders.
window.SH = window.SH || {};

SH.atmoConst = `
const float RE=6360e3, RA=6420e3, HR=7994., HM=1200.;
const vec3 BR=vec3(5.5e-6,13.0e-6,22.4e-6);
const vec3 BM=vec3(21e-6);
vec2 raySphere(vec3 ro, vec3 rd, float r){ float b=dot(ro,rd); float c=dot(ro,ro)-r*r; float d=b*b-c; if(d<0.) return vec2(1e12,-1e12); d=sqrt(d); return vec2(-b-d,-b+d); }
`;

SH.skyLut = SH.header + SH.atmoConst + `
uniform vec3 uSunDir, uMoonDir;
uniform float uSunI, uMoonI, uMie, uRay, uMieG, uAlt;
uniform vec3 uTint;
vec3 scatter(vec3 rd, vec3 L, float I){
  vec3 ro=vec3(0,RE+uAlt,0);
  vec2 ta=raySphere(ro,rd,RA); float tmax=ta.y;
  vec2 tg=raySphere(ro,rd,RE); if(tg.x>0.) tmax=min(tmax,tg.x);
  const int N=20; float ds=tmax/float(N);
  vec3 sR=vec3(0), sM=vec3(0); float odR=0., odM=0.;
  float mu=dot(rd,L);
  for(int i=0;i<N;i++){
    vec3 p=ro+rd*(float(i)+0.5)*ds; float h=length(p)-RE;
    float hr=exp(-h/HR)*ds, hm=exp(-h/HM)*ds; odR+=hr; odM+=hm;
    vec2 tl=raySphere(p,L,RA); float dl=tl.y/8.; float lR=0., lM=0.; bool ok=true;
    for(int j=0;j<8;j++){ vec3 q=p+L*(float(j)+0.5)*dl; float hq=length(q)-RE; if(hq<0.){ ok=false; break; } lR+=exp(-hq/HR)*dl; lM+=exp(-hq/HM)*dl; }
    if(ok){ vec3 tau=BR*uRay*(odR+lR)+BM*uMie*1.1*(odM+lM); vec3 at=exp(-tau); sR+=at*hr; sM+=at*hm; }
  }
  float pR=3./(16.*PI)*(1.+mu*mu);
  float g=uMieG; float pM=3./(8.*PI)*((1.-g*g)*(1.+mu*mu))/((2.+g*g)*pow(max(1.+g*g-2.*g*mu,1e-4),1.5));
  return I*(sR*BR*uRay*pR + sM*BM*uMie*pM);
}
void main(){
  vec2 uv=gl_FragCoord.xy/vec2(256.,128.);
  float az=(uv.x-0.5)*TAU; float el=uv.y*uv.y*PI*0.5;
  vec3 rd=vec3(cos(el)*cos(az), sin(el), cos(el)*sin(az));
  vec3 c=scatter(rd,uSunDir,uSunI);
  if(uMoonI>0.) c+=scatter(rd,uMoonDir,uMoonI)*vec3(0.8,0.9,1.1);
  c=c*uTint + vec3(0.0006,0.0009,0.0016);
  fragColor=vec4(c,1.);
}`;

// Helpers inserted into world shaders (need uniforms below).
SH.skyWorld = `
uniform sampler2D uSky;
uniform vec3 uSunDir, uSunCol, uMoonDir, uMoonCol;
uniform mat3 uStarRot;
uniform float uNight;
float gStarK=1.;
vec2 skyUV(vec3 d){ float el=asin(clamp(d.y,0.,1.)); return vec2(atan(d.z,d.x+1e-7)/TAU+0.5, sqrt(el/(0.5*PI))); }
vec3 skyL(vec3 d){ return textureLod(uSky, skyUV(d), 0.).rgb; }
vec3 stars(vec3 rd){
  vec3 d=uStarRot*rd; vec3 col=vec3(0);
  float pa=pixelAngle();
  vec3 mwN=normalize(vec3(0.3,0.5,0.8));
  float band=exp(-pow(dot(d,mwN)/0.22,2.));
  for(int l=0;l<3;l++){
    float sc = l==0 ? 90. : (l==1 ? 200. : 420.);
    vec3 p=d*sc; vec3 id=floor(p); vec3 f=p-id; vec3 h=hash33(id);
    float thr = l==0 ? 0.975 : (l==1 ? 0.955-0.05*band : 0.97-0.25*band);
    if(h.z>thr){
      vec3 c=0.2+0.6*hash33(id+17.);
      float dist=length(f-c);
      float w=max(pa*sc*0.9, 0.012);
      float b=pow(hash13(id+3.1), 4.) * (l==0 ? 5. : (l==1 ? 1.2 : 0.45));
      float tw=0.75+0.25*sin(uTime*(2.+h.y*5.)+h.x*40.);
      vec3 sc3=mix(vec3(1.,0.75,0.55), vec3(0.65,0.8,1.), h.y);
      col+=sc3*b*tw*exp(-dist*dist/(w*w));
    }
  }
  float mw=band*(0.55*fbm3(d*5.)+0.45*fbm3(d*13.));
  col+=vec3(0.11,0.1,0.16)*mw*mw*1.2 + vec3(0.05,0.035,0.03)*pow(band,4.)*fbm3(d*3.);
  return col*gStarK;
}
vec3 sunDisc(vec3 rd, float size){
  float sd=dot(rd,uSunDir);
  float r=cos(0.0105*size);
  vec3 c=uSunCol*smoothstep(r-0.00004*size,r+0.00002,sd)*30.;
  c+=uSunCol*(pow(max(sd,0.),2400./size)*3. + pow(max(sd,0.),120.)*0.15);
  return c;
}
vec3 moonDisc(vec3 rd, float size){
  float md=dot(rd,uMoonDir);
  float r=cos(0.016*size);
  if(md<r-0.001) return uMoonCol*pow(max(md,0.),300.)*0.25;
  vec3 up=abs(uMoonDir.y)<0.99?vec3(0,1,0):vec3(1,0,0);
  vec3 ax=normalize(cross(up,uMoonDir)), ay=cross(uMoonDir,ax);
  vec2 q=vec2(dot(rd,ax),dot(rd,ay))/(0.016*size);
  float tex=0.75+0.35*fbm(q*3.+4.)-0.25*smoothstep(0.55,0.75,fbm(q*2.+9.));
  float edge=smoothstep(r-0.00003,r+0.00002,md);
  return uMoonCol*tex*edge*9. + uMoonCol*pow(max(md,0.),300.)*0.25;
}
`;
