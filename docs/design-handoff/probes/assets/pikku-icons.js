/* Streamline Core line icon assets, CC BY 4.0. The AI character remains separate. */
(function(global){
 const files={home:'home',calendar:'calendar',plus:'add',routine:'routine',search:'search',check:'check',clock:'clock',send:'send',spark:'spark',more:'more',close:'close',profile:'profile',help:'help',wifi:'wifi',alert:'alert',trash:'trash',settings:'settings',bell:'bell'};
 function icon(name){
  const file=files[name];if(!file)return '';
  const url='assets/streamline-core/'+file+'.svg';
  return '<span class="pikku-icon'+(name==='more'?' is-vertical':'')+'" data-pikku-icon="'+name+'" style="-webkit-mask-image:url('+url+');mask-image:url('+url+')" aria-hidden="true"></span>';
 }
 global.PikkuIcon=icon;global.PIKKU_STREAMLINE_ICON_NAMES=Object.keys(files);
})(window);
