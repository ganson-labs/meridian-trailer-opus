// Post-processing: bloom chain, anamorphic streaks, god rays, final grade.
window.SH = window.SH || {};

SH.down = SH.header + `
uniform vec2 uRes; uniform sampler2D uSrc; uniform vec2 uSrcTexel; uniform float uFirst;
uniform sampler2D uText; uniform float uTextGlow;
vec3 s(vec2 uv){ return texture(uSrc, uv).rgb; }
void main(){
  vec2 uv=gl_FragCoord.xy/uRes; vec2 t=uSrcTexel;
  vec3 a=s(uv+t*vec2(-2,2)), b=s(uv+t*vec2(0,2)), c=s(uv+t*vec2(2,2));
  vec3 d=s(uv+t*vec2(-2,0)), e=s(uv), f=s(uv+t*vec2(2,0));
  vec3 g=s(uv+t*vec2(-2,-2)), h=s(uv+t*vec2(0,-2)), i=s(uv+t*vec2(2,-2));
  vec3 j=s(uv+t*vec2(-1,1)), k=s(uv+t*vec2(1,1)), l=s(uv+t*vec2(-1,-1)), m=s(uv+t*vec2(1,-1));
  vec3 col=e*0.125+(a+c+g+i)*0.03125+(b+d+f+h)*0.0625+(j+k+l+m)*0.125;
  if(uFirst>0.5){
    col=min(col, vec3(200.));
    col+=texture(uText, vec2(uv.x,1.-uv.y)).a*uTextGlow*vec3(1.,0.9,0.78);
  }
  fragColor=vec4(col,1.);
}`;

SH.up = SH.header + `
uniform vec2 uRes; uniform sampler2D uSrc; uniform vec2 uSrcTexel;
vec3 s(vec2 uv){ return texture(uSrc, uv).rgb; }
void main(){
  vec2 uv=gl_FragCoord.xy/uRes; vec2 t=uSrcTexel;
  vec3 c=s(uv)*4.+(s(uv+vec2(t.x,0.))+s(uv-vec2(t.x,0.))+s(uv+vec2(0.,t.y))+s(uv-vec2(0.,t.y)))*2.
        +(s(uv+t)+s(uv-t)+s(uv+vec2(t.x,-t.y))+s(uv+vec2(-t.x,t.y)));
  fragColor=vec4(c/16.,1.);
}`;

SH.streakPre = SH.header + `
uniform vec2 uRes; uniform sampler2D uSrc; uniform float uThresh;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec3 c=texture(uSrc,uv).rgb;
  float l=max(c.r,max(c.g,c.b));
  c*=max(l-uThresh,0.)/max(l,1e-4);
  fragColor=vec4(c,1.);
}`;

SH.streakBlur = SH.header + `
uniform vec2 uRes; uniform sampler2D uSrc; uniform vec2 uSrcTexel; uniform float uStep;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec3 c=vec3(0.); float ws=0.;
  for(int i=-7;i<=7;i++){ float w=exp(-float(i*i)/24.); c+=texture(uSrc, uv+vec2(float(i)*uStep*uSrcTexel.x,0.)).rgb*w; ws+=w; }
  fragColor=vec4(c/ws,1.);
}`;

SH.rays = SH.header + `
uniform vec2 uRes; uniform sampler2D uSrc; uniform vec2 uSunUV; uniform float uThresh, uDensity, uDecay; uniform float uAspect; uniform float uCap;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 d=(uSunUV-uv)*uDensity/72.;
  vec3 acc=vec3(0.); float w=1.;
  vec2 p=uv+d*fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  for(int i=0;i<72;i++){
    vec4 s4=texture(uSrc,p); vec3 c=min(s4.rgb, vec3(uCap));
    float l=dot(c,vec3(0.3,0.5,0.2));
    acc+=c*s4.a*smoothstep(uThresh, uThresh*2.5, l)*w;
    w*=uDecay; p+=d;
  }
  vec2 dd=(uv-uSunUV)*vec2(uAspect,1.);
  float fall=1./(1.+dot(dd,dd)*2.);
  fragColor=vec4(acc/72.*fall,1.);
}`;

SH.composite = SH.header + `
uniform sampler2D uHdr, uBloom, uStreak, uRays, uText;
uniform vec4 uRect;
uniform float uExposure, uBloomK, uStreakK, uRaysK, uCA, uGrain, uVig, uFade, uWhite, uSat, uContrast, uTime;
uniform vec3 uWB, uLift, uGain, uStreakTint;
float h12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec3 aces(vec3 x){ const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.,1.); }
void main(){
  vec2 uv=(gl_FragCoord.xy-uRect.xy)/uRect.zw;
  vec2 d=uv-0.5;
  vec3 c;
  c.r=texture(uHdr, uv-d*uCA).r;
  c.g=texture(uHdr, uv).g;
  c.b=texture(uHdr, uv+d*uCA).b;
  c+=texture(uBloom, uv).rgb*(uBloomK/6.);
  c+=texture(uStreak, uv).rgb*uStreakK*uStreakTint;
  c+=texture(uRays, uv).rgb*uRaysK;
  c*=uExposure*uWB;
  c=aces(c);
  c=pow(c, vec3(1./2.2));
  float l=dot(c, vec3(0.2126,0.7152,0.0722));
  c=mix(vec3(l), c, uSat);
  c=clamp((c-0.5)*uContrast+0.5, 0., 1.);
  c=c*uGain+uLift*(1.-c);
  c*=1.-uVig*smoothstep(0.35,1.45,length(d*vec2(2.,2.)));
  c+=(h12(gl_FragCoord.xy+fract(uTime*7.31)*vec2(113.,71.))-0.5)*uGrain*(1.-0.6*l);
  vec4 tx=texture(uText, vec2(uv.x,1.-uv.y));
  c=c*(1.-tx.a)+tx.rgb;
  c=mix(c, vec3(1.,0.97,0.92), uWhite);
  c*=uFade;
  fragColor=vec4(c,1.);
}`;
