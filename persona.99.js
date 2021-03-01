
const asleep = ms => new Promise(resolve => {
	setTimeout(resolve, ms);
});

class c_blocker {
	
	SYM_BREAK = Symbol();

	constructor() {
		this.reset();
	}

	reset() {
		this._blk_prm = new Promise(resolve => {
			this._blk_rslv = resolve;
		});
	}

	free() {
		this._blk_rslv?.(c_blocker.SYM_BREAK);
		this._blk_prm = null;
		this._blk_rslv = null;
	}

	get wait() {
		return this._blk_prm;
	}

}

const KEY_ASCH_BREAK = Symbol();
class c_async_scheduler {
        
    constructor() {
        this._ready_seq = [];
        this._all_blkr = new c_blocker();
        this._schdl_idx = 0;
        this._ready_idx = 0;
    }
    
    _add2ready(prio, tid) {
        let insert_idx = -1;
        for(let i = 0; i < this._ready_seq.length; i++) {
            let [dprio, dtid] = this._ready_seq[i];
            if(dtid === tid) {
                if(insert_idx < 0) {
                    return;
                } else {
                    this._ready_seq.splice(i, 1);
                    break;
                }
            }
            if(prio < dprio && insert_idx < 0) {
                insert_idx = i;
            }
        }
        if(insert_idx < 0) {
            this._ready_seq.push([prio, tid]);
        } else {
            this._ready_seq.splice(insert_idx, 0, [prio, tid]);
        }
    }
    
    async _schedule(prm, brkprm, prio, tid) {
        this._schdl_idx ++;
        let ret = await Promise.race([prm, brkprm, this._all_blkr.wait]);
        if(ret === KEY_ASCH_BREAK) {
            return KEY_ASCH_BREAK;
        }
        this._ready_idx ++;
        this._add2ready(prio, tid);
        let oridx, osidx;
        do {
            oridx = this._ready_idx;
            osidx = this._schdl_idx;
            await asleep(0); // wait for other ready tasks
        } while(oridx != this._ready_idx || osidx != this._schdl_idx // wait for all done
            || (this._ready_seq.length > 0 && this._ready_seq[0][1] !== tid)); // wait for prio first
        this._ready_seq.shift();
        return ret;
    }
    
    break_all() {
        this._all_blkr.free(KEY_ASCH_BREAK);
        this._all_blkr.reset();
    }
    
    newtask(prio) {
        let tid = Symbol();
        let task = {
            prio: prio,
        };
        let blocker = new c_blocker();
        task.break = () => {
            blocker.free(KEY_ASCH_BREAK);
            blocker.reset();
        };
        task.schedule = (nprm = null, nprio = null) => {
            return this._schedule(nprm, blocker.wait, (nprio ?? task.prio), tid);
        };
        task.hold = (nprio = null) => {
            this._add2ready((nprio ?? task.prio), tid);
        };
        task.is_break = ret => ret === KEY_ASCH_BREAK;
        return task;
    }
    
}

class c_param {
    
    constructor(val) {
        this.val = val;
    }
    
}

class c_param_pool {
    
    constructor() {
        this._pool = {};
    }
    
    param(key, val = undefined) {
        if(val === undefined) {
            return this._pool[key];
        }
        let par = this._pool[key];
        if(!par) {
            par = new c_param(val);
            this._pool[key] = par;
        } else {
            par.val = val;
        }
        return par;
    }
    
    update(dst) {
        for(let k in dst) {
            this.param(k, dst[k]);
        }
    }
    
}

const ERR_PRSN_BREAK = Symbol();
class c_persona {
	
	constructor() {
		this.scheduler = new c_async_scheduler();
        this.tasks = {};
        this.params = new c_param_pool();
	}
    
    start(tsklist, minds = {}) {
        for(let [tname, prio, ...args] of tsklist) {
            let is_loop = false;
            let mname = 'task_' + tname;
            if(this.tasks[tname]) {
                continue;
            } else if(!(this[mname] instanceof Function)) {
                mname = 'taskw_' + tname;
                if(!(this[mname] instanceof Function)) {
                    continue;
                }
                is_loop = true;
            }
            let task = this.scheduler.newtask(prio);
            this.tasks[tname] = task;
            task.chk_break = ret => {
                if(task.is_break(ret)) {
                    if(this.tasks[tname] === task) {
                        delete this.tasks[tname];
                    }
                    throw ERR_PRSN_BREAK;
                }
            };
            if(is_loop) {
                this.looptask(mname, task, ...args);
            } else {
                this.stdtask(mname, task, ...args);
            }
        }
        this.minds = minds;
    }
    
    get_params(args) {
        let rargs = [];
        for(let arg of args) {
            let val = arg;
            if(arg instanceof c_param) {
                val = arg.val;
            }
            rargs.push(val);
        }
        return rargs;
    }
    
    mind(mname) {
        let mind = this.minds[mname];
        if(mind) {
            this.params.update(mind);
        }
    }
    
    async stdtask(mtd_name, task, ...args) {
        try {
            return await this[mtd_name](task, ...this.get_params(args));
        } catch (e) {
            if(e === ERR_PRSN_BREAK) {
                return;
            }
            safe_log('Error:' + e);
        }
    }
    
    async looptask(mtd_name, task, ...args) {
        let control = {
            'need_wait': false,
        };
        let cfg = new Set();;
        if(args[0]?.slice?.(0, 4) === 'cfg:') {
            let scfg = args.shift().slice(4);
            if(scfg.length > 0) {
                cfg = new Set(scfg.split(','));
            }
        }
        while(true) {
            try {
                if(control.need_wait || !cfg.has('nowait')) {
                    task.chk_break(await task.schedule(this.wait_frame()))
                    control.need_wait = false;
                }
                await this[mtd_name](task, control, ...this.get_params(args));
            } catch(e) {
                if(e === ERR_PRSN_BREAK) {
                    break;
                }
				if(e.message) {
                	safe_log('Error:' + e.message);
				}
            }
        }
    }
	
	break(tname = null, dostop = true) {
		if(dostop) {
			stop();
		}
        if(tname) {
            let task = this.tasks[tname];
            if(task) {
                task.break();
            }
        } else {
            this.scheduler.break_all();
        }
	}
	
}

const step_val = (ov, nv, dist) => ov + (nv - ov) / dist;

class c_farmer_std extends c_persona {
    
    constructor() {
        super();
        this.stucked = false;
        this.battle = false;
        this.travel = false;
        this.runaway = false;
        this.tick = 0;
    }
    
    start() {
        super.start([
            ['minds', 3, ['bat1', 'bat2', 'bat3'], 60],
            ['loot', 5],
            ['supply', 8],
            ['shopping', 9, 'cfg:nowait'],
            //['target_monster', 10, 'goo'],
            //['target_monster', 10, 'poisio'],
			//['target_monster', 10, 'snake'],
			['target_monster', 10, this.params.param('tar_name', 'bat')],
            ['attack', 20, 'cfg:nowait'],
            ['move_back', 30, 'cfg:nowait', this.params.param('back_thr', 200)],
            //['move_back_smart', 40, 'cfg:nowait', [0, 0]],
			//['move_back_smart', 40, 'cfg:nowait', [-150, 850]],
			//['move_back_smart', 40, 'cfg:nowait', [330, -190]],
			//['move_back_smart', 40, 'cfg:nowait', [630, -360]],
			['move_back_smart', 40, 'cfg:nowait',
                this.params.param('back_path', [[590, -200], [600, -490], [310, -480], [290, -210]]),
                this.params.param('back_thr')],
            ['move_to_target', 50, 'cfg:nowait'],
            //['go_farm', 100, 'cfg:nowait', [0, 600]],
            //['go_farm', 100, 'cfg:nowait', [-250, 1150]],
			//['go_farm', 100, 'cfg:nowait', [-260, 1650]],
			//['go_farm', 100, 'cfg:nowait', [-50, -380], ['Mainland:cave']],
			//['go_farm', 100, 'cfg:nowait', [970, 90], ['Mainland:cave']],
			['go_farm', 100, 'cfg:nowait',
                this.params.param('tar_pos', [400, -850]),
                this.params.param('tar_doors', ['Mainland:cave'])],
        ], {
            'bat1': {
                'tar_pos': [-50, -380],
            },
            'bat2': {
                'tar_pos': [970, 90],
            },
            'bat3': {
                'tar_pos': [400, -850],
            },
        });
    }
    
    wait_frame() {
        return asleep(250);
    }
    
    dist_to(tar) {
        let x, y;
        if(tar instanceof Array) {
            [x, y] = tar;
        } else {
            x = tar.x;
            y = tar.y;
        }
        return Math.sqrt((x - character.x) ** 2 + (y - character.y) ** 2);
    }
    
    step_to(tar, step = 10) {
        let dist = this.dist_to(tar);
        return [
            step_val(character.x, tar.x, dist / step),
            step_val(character.y, tar.y, dist / step)]
    }
    
    choose_back_pos(tar, poslist) {
        if(!(poslist?.[0]?.length > 0)) {
            return poslist;
        }
        let x, y;
        if(tar instanceof Array) {
            [x, y] = tar;
        } else {
            x = tar.x;
            y = tar.y;
        }
        let tb_rad = Math.atan2(character.y - y, character.x - x);
        let dpos = null;
        let min_drad = Infinity;
        for(let pos of poslist) {
            let p_rad = Math.atan2(pos[1] - character.y, pos[0] - character.x);
            let drad = Math.abs(p_rad - tb_rad);
            if(drad > Math.PI) {
                drad = 2 * Math.PI - drad;
            }
            if(drad < min_drad) {
                min_drad = drad;
                dpos = pos;
            }
        }
        return dpos;
    }
    
    async wait_for_searching() {
        while(smart.searching === false) {
            await this.wait_frame();
        }
    }
    
    async _asmartmove(info) {
        try {
            await smart_move(info);
        } catch(e) {
            //if(e.reason === 'interrupted') {
            if('reason' in e) {
                stop();
                //safe_log('reason ' + e.reason);
                return false;
            } else {
                throw e;
            }
        }
        return true;
    }
    
    axmove(x, y) {
        let prm;
        let thk_prm = null;
        if(can_move_to(x, y)) {
            prm = move(x, y);
        } else {
            let brk = false;
            let wt_thk = async () => {
                while(!brk && smart.found === false) {
                    await this.wait_frame();
                }
            }
            prm = this._asmartmove({x:x, y:y}).then(() => {brk = true;});
            thk_prm = wt_thk();
        }
        prm.think = thk_prm;
        return prm;
    }
	
	amoveto(tar) {
		 let brk = false;
		let wt_thk = async () => {
			while(!brk && smart.found === false) {
				await this.wait_frame();
			}
		}
		let prm = this._asmartmove({to:tar}).then(() => {brk = true;});
		let thk_prm = wt_thk();
		prm.think = thk_prm;
        return prm;
	}
    
    async taskw_minds(task, ctrl, mindlist, dminutes = 60) {
        let midx = Math.floor((this.tick ++) / (dminutes * 60 * 4)) % mindlist.length;
        this.mind(mindlist[midx]);
    }
    
    async taskw_loot(task, ctrl) {
        loot();
    }
    
    async taskw_supply(task, ctrl) {
        if(is_on_cooldown("use_hp")) return;
        let hpv = character.hp/character.max_hp,
            mpv = character.mp/character.max_mp;
        if(mpv < 0.2) use_skill('use_mp');
        else if(hpv < 0.8) use_skill('use_hp');
        else if(mpv < 0.5) use_skill('use_mp');
        else if(hpv < 0.9) use_skill('regen_hp');
        else if(mpv < 0.9) use_skill('regen_mp');
    }
    
    async taskw_shopping(task, ctrl) {
        if(quantity('hpot0') > 50 && quantity('mpot0') > 50) {
            ctrl.need_wait = true;
            return;
        }
        set_message("Go shopping");
        task.hold();
        task.chk_break(await task.schedule(this.amoveto('town')));
        set_message("shopping");
        if(quantity('hpot0') < 100) {
            buy('hpot0', 200);
        }
        if(quantity('mpot0') < 100) {
            buy('mpot0', 200);
        }
		task.chk_break(await task.schedule(asleep(1000)));
    }
    
    async taskw_target_monster(task, ctrl, tname) {
        let target = get_targeted_monster();
        if(target?.mtype === tname) {
            return;
        }
        target = get_nearest_monster({type: tname});
        if(target) {
            set_message("Targeted");
        }
        change_target(target);
    }
    
    async taskw_go_farm(task, ctrl, pos = [0, 0], doorseq = []) {
        if(is_moving(character) || this.dist_to(pos) < 10) {
            ctrl.need_wait = true;
            return;
        }
        set_message("Go farm");
        //safe_log('travel');
        change_target();
        this.stucked = false;
        this.travel = true;
		for(let doordesc of doorseq) {
			let [cmap, door] = doordesc.split(':');
			if(cmap !== get_map().name) {
				continue;
			}
			task.chk_break(await task.schedule(this.amoveto(door)));
		}
        task.chk_break(await task.schedule(
            this.axmove(...pos).then(() => {
                this.travel = false;
                //safe_log('trav done');
            })
        ));
    }
    
    async taskw_move_to_target(task, ctrl, step = 10) {
        let target = get_targeted_monster();
        if(!target) {
            ctrl.need_wait = true;
            return;
        }
        if(is_moving(character)
            || is_in_range(target)) {
            ctrl.need_wait = true;
			task.hold();
            return;
        }
        let [nx, ny] = this.step_to(target, step);
        if(!can_move_to(nx, ny)) {
            this.stucked = true;
            ctrl.need_wait = true;
            return;
        }
        set_message("Move to");
        this.stucked = false;
        task.hold();
        task.chk_break(await task.schedule(move(nx, ny)));
    }
    
    async taskw_move_back(task, ctrl, thr = 120, step = 10) {
        let target = get_targeted_monster();
        if(!target) {
            if(this.runaway) {
                //safe_log('run stop');
                stop();
            }
            ctrl.need_wait = true;
            return;
        }
        let dist = this.dist_to(target);
        if(dist > thr) {
            if(this.runaway) {
                //safe_log('run stop');
                stop();
            }
            ctrl.need_wait = true;
            return;
        }
        if(is_moving(character)
            || !is_in_range(target)) {
            ctrl.need_wait = true;
            return;
        }
        let [nx, ny] = this.step_to(target, -step);
        if(!can_move_to(nx, ny)) {
            this.stucked = true;
            ctrl.need_wait = true;
            return;
        }
        set_message("Move back");
        this.stucked = false;
        //safe_log('run move');
        task.chk_break(await task.schedule(move(nx, ny)));
    }
    
    async taskw_move_back_smart(task, ctrl, pos, thr = 120) {
        let target = get_targeted_monster();
        if(!this.stucked
            || this.runaway
            || is_moving(character)
            || !target
            || !is_in_range(target)) {
            ctrl.need_wait = true;
            return;
        }
        let dist = this.dist_to(target);
        if(dist > thr) {
            ctrl.need_wait = true;
            return;
        }
        pos = this.choose_back_pos(target, pos);
        set_message("Run search");
        //safe_log('search');
        let prm = this.axmove(...pos);
        task.hold();
        task.chk_break(await task.schedule(prm.think));
        set_message("Run away");
        //safe_log('run');
        this.runaway = true;
        task.chk_break(await task.schedule(prm));
        task.chk_break(await task.schedule(
            prm.then(() => {
                this.runaway = false;
                //safe_log('run done');
            })
        ));
    }
    
    async taskw_attack(task, ctrl) {
        let target = get_targeted_monster();
        if(!target || !can_attack(target)) {
            this.battle = false;
            ctrl.need_wait = true;
            return;
        }
        set_message("Attacking");
        this.battle = true;
        if(this.travel) {
            //safe_log('trav stop');
            stop();
        }
        task.chk_break(await task.schedule(attack(target)));
    }
    
}

ch1 = new c_farmer_std();
ch1.start();
