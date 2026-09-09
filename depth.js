import * as THREE from './three.module.js';

const host = document.getElementById('market-emblem');
if (host) {
  try {
    const renderer = new THREE.WebGLRenderer({ alpha:true, antialias:true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    host.append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
    camera.position.set(0, 0, 6);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x50665b, 3));
    const light = new THREE.DirectionalLight(0xffffff, 4);
    light.position.set(-3, 4, 5);
    scene.add(light);
    const wheel = new THREE.Group();
    scene.add(wheel);
    const rubber = new THREE.MeshStandardMaterial({color:0x24312d, roughness:0.85});
    const alloy = new THREE.MeshStandardMaterial({color:0xe2e8e6, metalness:0.65, roughness:0.27});
    const accent = new THREE.MeshStandardMaterial({color:0xa6ce77, metalness:0.35, roughness:0.35});
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.91,0.25,16,48),rubber));
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.72,0.065,12,48),alloy));
    for(let i=0;i<5;i++) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14,1.38,0.13),alloy);
      arm.rotation.z=i*Math.PI/5;
      wheel.add(arm);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.21,0.21,0.23,24),accent);
    hub.rotation.x=Math.PI/2;
    wheel.add(hub);
    const models={wheel};
    function box(group,w,h,d,x,y,material=alloy) {
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
      mesh.position.set(x,y,0);group.add(mesh);return mesh;
    }
    const hammer=new THREE.Group();
    box(hammer,0.18,1.65,0.18,0,-0.15,accent);
    box(hammer,1.3,0.58,0.62,0,0.65);
    box(hammer,1.35,0.18,0.8,0,-1,rubber);
    hammer.rotation.z=-0.25;models.hammer=hammer;scene.add(hammer);
    const buildings=new THREE.Group();
    for(let i=0;i<3;i++) {
      const height=0.9+i*0.45;
      box(buildings,0.55,height,0.7,(i-1)*0.65,height/2-0.9,i===1?accent:alloy);
      for(let j=0;j<3;j++) box(buildings,0.29,0.1,0.04,(i-1)*0.65,j*0.24-0.5,rubber).position.z=0.38;
    }
    models.buildings=buildings;scene.add(buildings);
    const award=new THREE.Group();
    const medal=new THREE.Mesh(new THREE.CylinderGeometry(0.75,0.75,0.2,8),accent);
    medal.rotation.x=Math.PI/2;award.add(medal);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(0.48,0.055,12,40),alloy);
    ring.position.z=0.15;award.add(ring);
    box(award,0.3,0.9,0.12,-0.26,-0.75,rubber).rotation.z=-0.22;
    box(award,0.3,0.9,0.12,0.26,-0.75,rubber).rotation.z=0.22;
    models.award=award;scene.add(award);
    let current=wheel;
    function placeEmblem() {
      const view=document.querySelector('.view.active-view');
      if(!view)return;
      const heading=view.querySelector('.section-heading > div:first-child');
      if(!heading){host.hidden=true;return;}
      host.hidden=false;
      if(host.parentElement!==heading){host.parentElement.classList.remove('depth-heading');heading.append(host);}
      heading.classList.add('depth-heading');
      const name=view.id.split('-')[0];
      const kind=['auctions','deals'].includes(name)?'hammer':['assets','business'].includes(name)?'buildings':['profile','rating','store'].includes(name)?'award':'wheel';
      for(const [key,model] of Object.entries(models))model.visible=key===kind;
      current=models[kind];
    }
    placeEmblem();
    document.querySelectorAll('.view').forEach(view=>new MutationObserver(placeEmblem).observe(view,{attributes:true,attributeFilter:['class']}));
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    let visible=false, target=0, frame=0;
    function draw(time=0) {
      frame=0;
      current.rotation.y=0.35+(reduced.matches?0:Math.sin(time/2200)*0.12+target);
      current.rotation.x=-0.18;
      renderer.render(scene,camera);
      if(visible&&!document.hidden&&!reduced.matches) frame=requestAnimationFrame(draw);
    }
    function update() {
      cancelAnimationFrame(frame);
      frame=0;
      if(visible&&!document.hidden) draw();
    }
    new ResizeObserver(()=>{
      const {width,height}=host.getBoundingClientRect();
      if(!width||!height)return;
      renderer.setSize(width,height,false);
      camera.aspect=width/height;
      camera.updateProjectionMatrix();
      update();
    }).observe(host);
    new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;update();}).observe(host);
    host.parentElement.addEventListener('pointermove',e=>{
      const bounds=host.parentElement.getBoundingClientRect();
      target=Math.max(-0.2,Math.min(0.2,(e.clientX-bounds.left)/bounds.width*0.4-0.2));
    });
    host.parentElement.addEventListener('pointerleave',()=>{target=0;});
    document.addEventListener('visibilitychange',update);
    reduced.addEventListener('change',update);
    renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();visible=false;cancelAnimationFrame(frame);});
  } catch(error) {
    host.hidden=true;
    host.parentElement.style.paddingLeft='0';
  }
}
