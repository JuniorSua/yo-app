/** GLSL for living avatars (WebGL2). Ported from the goo-agents design prototype (preview v3). */

/** The render on a fine grid: jello ripples, spring-lagged top (shear), squash, lean. */
export const VS_MESH = `#version 300 es
in vec2 aUV;
uniform vec4 uRect; uniform vec2 uAnchor; uniform float uScale; uniform vec2 uPos; uniform float uH;
uniform vec2 uSq; uniform float uLean; uniform float uShear; uniform float uWob; uniform float uT;
uniform float uRipple; uniform float uRippleT; uniform vec4 uView;
out vec2 vPx;
void main() {
  vec2 px = mix(uRect.xy, uRect.zw, aUV);
  vPx = px;
  vec2 l = (px - uAnchor) * uScale;
  vec2 c = vec2(0.0, -0.48 * uH);
  vec2 v = l - c; float r = length(v); float R = 0.5 * uH;
  if (r > 0.001) {
    float th = atan(v.y, v.x);
    float off = uWob * (0.5 * sin(3.0 * th + uT / 520.0) + 0.3 * sin(5.0 * th - uT / 780.0));
    off += uRipple * sin(4.0 * th - uRippleT / 95.0);
    l = c + v / r * (r + off * smoothstep(0.25 * R, 1.05 * R, r));
  }
  float h = clamp(-l.y / uH, 0.0, 1.2);
  l.x += uShear * pow(h, 1.35);
  l *= uSq;
  float cs = cos(uLean), sn = sin(uLean);
  l = vec2(cs * l.x - sn * l.y, sn * l.x + cs * l.y);
  vec2 wp = uPos + l;
  gl_Position = vec4((wp.x - uView.x) / uView.z * 2.0 - 1.0, 1.0 - (wp.y - uView.y) / uView.w * 2.0, 0.0, 1.0);
}`;

/**
 * Eye-free face (clean skin) + the original eyes as a movable layer (gaze, lids), body/headset recolour,
 * screen light, and ink on top: sleeping lid curve, happy arcs, "?" glyphs.
 */
export const FS_MESH = `#version 300 es
precision highp float;
in vec2 vPx;
uniform sampler2D uTex; uniform sampler2D uClean; uniform sampler2D uEyeT; uniform sampler2D uMask; uniform sampler2D uGlyph;
uniform vec2 uTexSize; uniform vec4 uEyeL; uniform vec4 uEyeR; uniform vec2 uGaze;
uniform float uClose; uniform float uHappy; uniform float uQuestion; uniform float uQPop; uniform float uSil; uniform float uSleep; uniform float uScreen;
uniform vec3 uRecolor; uniform vec3 uHsDark; uniform vec3 uHsLight; uniform float uHsOn;
out vec4 o;
vec3 rgb2hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); float e=1e-10; return vec3(abs(q.z+(q.w-q.y)/(6.*d+e)),d/(q.x+e),q.x); }
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
const vec3 INK = vec3(0.075,0.08,0.13);
vec2 eq(vec4 e, vec2 p){ return (p-e.xy)/(e.zw*vec2(0.62,0.56)); }
float glyphA(vec4 e, vec2 p, out vec3 col){
  float hq=max(uQPop,0.35)*1.38, fade=smoothstep(0.0,0.35,uQPop);
  vec2 g=(p-e.xy)/vec2(e.w*hq*0.8,e.w*hq)+0.5;
  vec4 t=texture(uGlyph,g); col=t.rgb;
  return t.a*fade*step(0.,g.x)*step(g.x,1.)*step(0.,g.y)*step(g.y,1.);
}
void main(){
  vec2 px=vPx, uv=px/uTexSize;
  vec4 o0=texture(uTex,uv);
  if(uSil>0.5){ o=vec4(1.,1.,1.,o0.a); return; }
  vec4 cl=texture(uClean,uv);
  vec2 et=texture(uEyeT,uv).rg;
  vec4 c=mix(o0,vec4(cl.rgb,o0.a),et.r);
  vec2 pe=px-uGaze, uve=pe/uTexSize;
  vec4 eo=texture(uTex,uve); float em=texture(uEyeT,uve).g;
  vec2 qL=eq(uEyeL,pe), qR=eq(uEyeR,pe);
  vec2 q=length(qL)<length(qR)?qL:qR;
  float lid=clamp(uClose,0.,1.);
  float cover=lid>0.98?1.:smoothstep(1.-lid-0.06,1.-lid+0.06,abs(q.y));
  float show=em*(1.-cover)*(1.-uHappy)*(1.-uQuestion);
  c.rgb=mix(c.rgb,eo.rgb,show);
  vec2 mk=texture(uMask,uv).rg;
  vec3 h=rgb2hsv(c.rgb);
  vec3 rc=hsv2rgb(vec3(fract(h.x+uRecolor.x/360.+1.),clamp(h.y*uRecolor.y,0.,1.),clamp(h.z*uRecolor.z,0.,1.)));
  c.rgb=mix(c.rgb,rc,mk.g*(1.-mk.r));
  if(uHsOn>0.5){
    float lum=dot(c.rgb,vec3(0.2126,0.7152,0.0722));
    float tt=pow(clamp((lum-0.02)/0.3,0.,1.),0.75);
    c.rgb=mix(c.rgb,mix(uHsDark,uHsLight,tt),mk.r*(1.-et.r));
  }
  c.rgb+=uScreen*vec3(0.02,0.045,0.09)*mk.g*(1.-mk.r);
  float ly=q.y-uSleep*0.2*(1.-q.x*q.x);
  float lidLine=(1.-smoothstep(0.07,0.13,abs(ly)))*(1.-smoothstep(0.7,0.82,abs(q.x)))*smoothstep(0.8,0.98,uClose)*(1.-uHappy)*(1.-uQuestion);
  c.rgb=mix(c.rgb,INK,lidLine);
  float ya=0.3-0.95*(1.-q.x*q.x);
  float arc=(1.-smoothstep(0.11,0.19,abs(q.y-ya)))*(1.-smoothstep(0.86,0.98,abs(q.x)))*step(length(q),1.6);
  c.rgb=mix(c.rgb,INK,arc*uHappy);
  vec3 gcL, gcR;
  float aL=glyphA(uEyeL,pe,gcL), aR=glyphA(uEyeR,pe,gcR);
  c.rgb=mix(c.rgb,gcL,aL); c.rgb=mix(c.rgb,gcR,aR);
  o=c;
}`;

export const VS_FULL = `#version 300 es
in vec2 aP; out vec2 vUV;
void main(){ vUV=aP*0.5+0.5; gl_Position=vec4(aP,0.,1.); }`;

export const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uT; uniform vec2 uDir; out vec4 o;
void main(){
  float w[8]=float[8](0.1383,0.1311,0.1116,0.0853,0.0586,0.0362,0.0200,0.0099);
  float s=texture(uT,vUV).a*w[0];
  for(int i=1;i<8;i++){ s+=texture(uT,vUV+uDir*float(i)).a*w[i]; s+=texture(uT,vUV-uDir*float(i)).a*w[i]; }
  o=vec4(1.,1.,1.,s);
}`;

/** Behind the body: contact shadow + the yellow halo hugging the outline. */
export const FS_BACK = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uNear; uniform sampler2D uWide; uniform vec4 uView;
uniform vec4 uSh; uniform float uShA; uniform float uGlow; uniform vec3 uGlowCol;
out vec4 o;
void main(){
  vec2 w=vec2(uView.x+vUV.x*uView.z, uView.y+(1.-vUV.y)*uView.w);
  float sh=uShA*(1.-smoothstep(0.,1.,length((w-uSh.xy)/uSh.zw)));
  float near=uGlow>0.002?texture(uNear,vUV).a:0., wide=uGlow>0.002?texture(uWide,vUV).a:0.;
  float ring=smoothstep(0.0,0.5,near);
  float halo=pow(smoothstep(0.0,0.5,wide),1.4)*0.8;
  float g=clamp((ring*0.62+halo)*uGlow,0.,1.);
  float a=g+sh*(1.-g);
  vec3 col=a>0.? (uGlowCol*g)/a : vec3(0.);
  o=vec4(col,a);
}`;

/** On top of the body: a warm rim light along its inside edge (question only). */
export const FS_RIM = `#version 300 es
precision highp float;
in vec2 vUV; uniform sampler2D uSil; uniform sampler2D uNear; uniform float uGlow; uniform vec3 uGlowCol;
out vec4 o;
void main(){
  float s=texture(uSil,vUV).a, near=texture(uNear,vUV).a;
  float rim=s*(1.-smoothstep(0.5,0.98,near));
  o=vec4(uGlowCol, rim*uGlow*0.42);
}`;
