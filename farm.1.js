// Hey there!
// This is CODE, lets you control your character with code.
// If you don't know how to code, don't worry, It's easy.
// Just set attack_mode to true and ENGAGE!

const asleep = ms => new Promise(resolve => {
	setTimeout(resolve, ms);
});

var attack_mode=true

const dist_to = pos => Math.sqrt((pos.x - character.x) ** 2 + (pos.y - character.y) ** 2);
const step_val = (ov, nv, dist) => ov + (nv - ov) / dist;

function step_to(pos, step = 10) {
	let dist = dist_to(pos);
	return [
		step_val(character.x, pos.x, dist / step),
		step_val(character.y, pos.y, dist / step)]
}

function step_back(pos, thr, step = 10) {
	let dist = dist_to(pos);
	if(dist > thr) return [];
	let [nx, ny] = step_to(pos, -step);
	if(!can_move_to(nx, ny)) {
		return [undefined, null];
	}
	return [nx, ny];
}

let static_stat = 'idle';
async function farm(tar_name, start_pos = [0, 600], reset_pos = [0, 0],
					backstep = 10) {
	let target = get_targeted_monster();
	if(!target) {
		if(!tar_name) {
			target=get_nearest_monster({min_xp:100,max_att:120});
		} else {
			target = get_nearest_monster({type: tar_name});
		}
		if(target) {
			set_message("Targeted");
			change_target(target);
			static_stat = 'tar';
		} else {
			//safe_log("No Monsters");
			set_message("No Monsters");
			if(!is_moving(character)) {
				xmove(...start_pos);
			}
			static_stat = 'idle';
			return;
		}
	}
	
	if(is_moving(character)) {
		if(static_stat === 'idle') {
			stop();
			static_stat = 'tar';
		} else {
			return;
		}
	}
	
	if(!is_in_range(target))
	{
		let [nx, ny] = step_to(target);
		if(can_move_to(nx, ny)) {
			move(nx, ny);
		} else {
			xmove(...start_pos);
			change_target();
			static_stat = 'idle';
		}
	}
	else {
		let [nx, ny] = step_back(target, 100, backstep);
		if(nx !== undefined) {
			move(nx, ny);
		} else if(can_attack(target)) {
			if(ny === null) {
				set_message("Running");
				xmove(...reset_pos);
				await asleep(6000);
				//safe_log('here');
				stop();
				static_stat = 'idle';
			}
			set_message("Attacking");
			attack(target);
		}
	}
}

function use_hp_or_mp_custom()
{
	if(safeties && mssince(last_potion)<min(200,character.ping*3)) return;
	var used=true;
	if(is_on_cooldown("use_hp")) return;
	if(character.mp/character.max_mp<0.2) use_skill('use_mp'); 
	else if(character.hp/character.max_hp<0.8) use_skill('use_hp');
	else if(character.mp/character.max_mp<0.5) use_skill('use_mp');
	else if(character.hp/character.max_hp<0.9) use_skill('regen_hp');
	else if(character.mp/character.max_mp<0.9) use_skill('regen_mp');
	else used=false;
	if(used) last_potion=new Date();
}

let mind = 1;

let mind_tick = 0;
function update_mind(cnt) {
	if(mind_tick ++ > 240 * 60) {
		mind = (mind + 1) % 2;
		mind_tick = 0;
	}
}

setInterval(async function(){

	use_hp_or_mp_custom();
	loot();

	if(!attack_mode || character.rip) return;
	update_mind();
	switch(mind) {
		case 0:
			await farm('goo', [0, 600]);
			break;
		case 1:
			await farm('bee', [350, 960]);//[290, 980]);
			break;
		case 2:
			await farm('bee', [770, 850], [1260, 360])//[1000, 1030]);
			break;
		case 3:
			await farm('poisio', [-250, 1150], [0, 0], 80);
			break;
		case 4:
			await farm('pompom', [0, 390], [90, -30], 80);
		default:
			//do nothing;
	}

},1000/4); // Loops every 1/4 seconds.

// Learn Javascript: https://www.codecademy.com/learn/introduction-to-javascript
// Write your own CODE: https://github.com/kaansoral/adventureland
