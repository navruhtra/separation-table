# Vector test art drawn at film resolution (the truth), then shrunk to 900 px (the input), like an exported PNG
import sys, numpy as np
from PIL import Image, ImageDraw, ImageFont
T=sys.argv[1]; W,H=900,600; S=4400/900; SS=2; Wt,Ht=4400,round(600*S)
big=Image.new('RGBA',(Wt*SS,Ht*SS),(0,0,0,0)); d=ImageDraw.Draw(big); k=S*SS
WH=(244,244,240,255); SC=(216,38,47,255); GY=(247,181,0,255); PK=(239,111,166,255); CR=(221,215,182,255)
F=lambda s: ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',int(s*k))
# opaque panel with a soft vertical fade (not an ink) and a soft glow
y0,y1=320,585; arr=np.zeros((int((y1-y0)*k),int(820*k),4),np.uint8); t=np.linspace(0,1,arr.shape[0])[:,None]
top=np.array([14,72,74]); bot=np.array([8,38,42]); col=top+(bot-top)*t[...,None]
yy,xx=np.mgrid[0:arr.shape[0],0:arr.shape[1]]; r=np.hypot(xx-680*k,yy-130*k)/(110*k); g=np.clip(1-r,0,1)**1.5
glow=np.array([232,184,150]); col=col*(1-g[...,None])+glow*g[...,None]; arr[...,:3]=col; arr[...,3]=255
big.alpha_composite(Image.fromarray(arr),(int(40*k),int(y0*k)))
d.text((40*k,20*k),'MADE IN USA',font=F(70),fill=WH); d.text((40*k,112*k),'SINCE 1776 - EST. AMERICA',font=F(26),fill=WH); d.text((40*k,152*k),'small type: printed with pride on every shirt',font=F(13),fill=WH)
for i,w in enumerate([1.5,3,5,9]):
    y=195+i*22; d.rectangle([40*k,(y-w/2)*k,420*k,(y+w/2)*k],fill=WH)
    x=460+i*28; d.line([(x*k,180*k),((x+90)*k,290*k)],fill=WH,width=round(w*k))
d.ellipse([600*k,40*k,800*k,240*k],outline=WH,width=round(14*k)); d.ellipse([650*k,90*k,750*k,190*k],fill=SC)
d.rectangle([600*k,262*k,860*k,300*k],fill=GY)
for y,w,c in [(355,4,CR),(385,4,CR),(415,4,WH),(445,3,PK),(475,6,CR)]: d.rectangle([80*k,(y-w/2)*k,560*k,(y+w/2)*k],fill=c)
d.rectangle([150*k,535*k,750*k,540*k],fill=CR)  # a line that runs into the ring
d.ellipse([30*k,525*k,870*k,1325*k],outline=WH,width=round(16*k))  # a ring over the line's ends
truth=big.resize((Wt,Ht),Image.BOX); truth.save(T+'/truth.png'); inp=truth.resize((W,H),Image.BOX); inp.save(T+'/input.png')
np.asarray(inp).tofile(T+'/input.rgba'); np.asarray(truth).tofile(T+'/truth.rgba')
# region masks at truth size: edges (colour changes within 6 px), the glow, the rest
a=np.asarray(truth).astype(np.int16); sh=np.array([17,17,17]); comp=(a[...,:3]*(a[...,3:]/255)+sh*(1-a[...,3:]/255))
mx=np.zeros(comp.shape[:2])
for dy in range(-6,7,3):
    for dx in range(-6,7,3): mx=np.maximum(mx,np.abs(np.roll(comp,(dy,dx),(0,1))-comp).sum(2))
edge=mx>40; glowm=np.zeros_like(edge); gy,gx=np.mgrid[0:Ht,0:Wt]; glowm=(np.hypot(gx-720*S,gy-450*S)<120*S)&~edge
np.save(T+'/masks.npy',np.stack([edge,glowm])); print(truth.size, edge.mean(), glowm.mean())
