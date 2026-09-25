// The tidally locked planet seen from orbit (intro + title card).
window.SH = window.SH || {};

SH.planetBody = `
uniform vec4 uA, uB;      // uA: x spin angle, y city lights, z cloud angle, w atmosphere gain ; uB: x sun size
uniform vec3 uSun0;       // original subsolar direction (climate frame)
vec3 rotAxis(vec3 v, vec3 k, float a){ float c=cos(a), s=sin(a); return v*c+cross(k,v)*s+k*dot(k,v)*(1.-c); }
vec2 sph(vec3 ro, vec3 rd, float r){ float b=dot(ro,rd); float c=dot(ro,ro)-r*r; float d=b*b-c; if(d<0.) return vec2(-1.); d=sqrt(d); return vec2(-b-d,-b+d); }
const vec3 AX=vec3(0.1478,0.9853,0.0853);
const float RP=1., RA=1.05, HA=0.011;
vec3 sunTrans(vec3 q){
  float mu=dot(normalize(q), uSunDir);
  float h=max(length(q)-RP,0.);
  float od=exp(-h/HA)/max(mu+0.13,0.018);
  return exp(-vec3(0.1,0.26,0.62)*od*0.9);
}
vec3 surface(vec3 p, vec3 n, vec3 rd){
  vec3 sp=rotAxis(n, AX, -uA.x);
  float mu=dot(sp, uSun0);
  float h=fbm3(sp*2.1+1.3)*0.75+fbm3(sp*6.5+4.)*0.25;
  float land=smoothstep(0.495,0.51,h);
  float mtn=smoothstep(0.55,0.68,h);
  vec3 lc;
  vec3 desert=mix(vec3(0.78,0.56,0.32), vec3(0.9,0.72,0.46), fbm3(sp*9.));
  vec3 arid=vec3(0.5,0.3,0.17);
  vec3 green=mix(vec3(0.11,0.22,0.07), vec3(0.2,0.26,0.1), fbm3(sp*12.));
  vec3 snow=vec3(0.86,0.9,0.96);
  lc=mix(snow, green, smoothstep(-0.2,-0.08,mu));
  lc=mix(lc, arid, smoothstep(0.08,0.22,mu));
  lc=mix(lc, desert, smoothstep(0.3,0.5,mu));
  lc=mix(lc, lc*0.7+0.1, mtn);
  vec3 oc=mix(vec3(0.72,0.8,0.9), vec3(0.01,0.04,0.09), smoothstep(-0.25,-0.1,mu));
  oc=mix(oc, vec3(0.02,0.07,0.1), smoothstep(0.6,0.9,mu));
  vec3 alb=mix(oc, lc, land);
  float ndl=dot(n,uSunDir);
  vec3 tr=sunTrans(p*1.001);
  float day=smoothstep(-0.03,0.2,ndl);
  vec3 col=alb*tr*max(ndl,0.)*1.7*mix(0.6,1.,day);
  // ocean glint
  vec3 hv=normalize(uSunDir-rd);
  col+=(1.-land)*step(-0.15,mu)*tr*pow(max(dot(n,hv),0.),90.)*2.5*step(0.,ndl);
  // clouds
  vec3 cp=rotAxis(n, AX, -uA.z);
  float cl=smoothstep(0.52,0.75,fbm3(cp*3.2+vec3(0.,0.,uA.z*0.2))*0.7+fbm3(cp*11.)*0.3);
  cl*=smoothstep(0.95,0.5,abs(dot(sp,uSun0)));
  col=mix(col, vec3(1.)*tr*max(ndl+0.05,0.)*1.8, cl*0.85);
  // night side: the living belt glows
  float belt=exp(-mu*mu/0.012);
  float city=smoothstep(0.7,0.95,noise3(sp*70.))*smoothstep(0.55,0.8,noise3(sp*9.));
  col+=vec3(1.,0.62,0.28)*city*belt*land*(1.-day)*uA.y*1.4*(1.-cl);
  col+=alb*vec3(0.004,0.007,0.014)*(1.-day);
  return col;
}
vec3 atmosphere(vec3 ro, vec3 rd, float tEnd){
  vec2 ha=sph(ro, rd, RA);
  if(ha.y<0.) return vec3(0.);
  float t0=max(ha.x,0.), t1=min(ha.y, tEnd);
  if(t1<=t0) return vec3(0.);
  float ds=(t1-t0)/16.;
  vec3 acc=vec3(0.); float od=0.;
  float mu=dot(rd,uSunDir);
  float pR=0.75*(1.+mu*mu);
  float g=0.82; float pM=(1.-g*g)/pow(1.+g*g-2.*g*mu,1.5)*0.08;
  for(int i=0;i<16;i++){
    vec3 q=ro+rd*(t0+(float(i)+0.5)*ds);
    float h=length(q)-RP;
    float den=exp(-h/HA);
    od+=den*ds;
    vec3 tr=sunTrans(q);
    vec2 sh=sph(q, uSunDir, RP);
    float lit = (sh.x>0.) ? 0. : 1.;
    acc+=den*ds*tr*lit*exp(-vec3(0.1,0.26,0.62)*od*28.)*(vec3(0.16,0.42,1.)*pR*1.4+vec3(1.,0.9,0.8)*pM);
  }
  return acc*9.*uA.w;
}
void main(){
  vec3 ro=uCamPos; vec3 rd=camRay(gl_FragCoord.xy);
  vec3 col=stars(rd)*0.3;
  vec2 hp=sph(ro, rd, RP);
  float tEnd=1e9;
  if(hp.x>0.){
    vec3 p=ro+rd*hp.x; vec3 n=normalize(p);
    col=surface(p, n, rd);
    tEnd=hp.x;
  } else {
    col+=sunDisc(rd, uB.x);
  }
  col+=atmosphere(ro, rd, tEnd);
  fragColor=vec4(max(col,0.), hp.x>0. ? 0. : 1.);
}
`;

SH.buildPlanet = function () {
  return SH.header + '#define SUN_SIZE 1.\n' + SH.noise + SH.sdf + SH.camera + SH.skyWorld + SH.planetBody;
};
