'use strict';
const path=require('path');
const {spawnSync}=require('child_process');
const out=path.join(__dirname,'output');
const filter='fps=30,scale=1600:600:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle';
const result=spawnSync('ffmpeg',['-y','-hide_banner','-loglevel','warning','-i',path.join(out,'storm-cyclone.mp4'),'-filter_complex',filter,'-loop','0','-threads','2',path.join(out,'storm-cyclone.gif')],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status||0;
