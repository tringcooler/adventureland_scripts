
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
                if(task.force_break || task.is_break(ret)) {
                    task.remove();
                    throw ERR_PRSN_BREAK;
                }
                return ret;
            };
            task.remove = () => {
                if(this.tasks[tname] === task) {
                    delete this.tasks[tname];
                    if(Object.keys(this.tasks).length === 0) {
                        this.emit_idle?.();
                    }
                }
            };
            task.force_break = false;
            if(is_loop) {
                this.looptask(mname, task, ...args);
            } else {
                this.stdtask(mname, task, ...args);
            }
        }
        this.minds = minds;
    }
    
    emit_idle() {
        let hndl;
        while(hndl = this.idle_hndls?.shift?.()) {
            if(hndl instanceof Function) {
                hndl();
            }
        }
    }
    
    on_idle(hndl) {
        if(!(hndl instanceof Function)) {
            return;
        }
        if(!this.idle_hndls) {
            this.idle_hndls = [];
        }
        this.idle_hndls.push(hndl);
    }
    
    setup_sense() {
        this.sense_hndls = {};
        return (sname, fmatch) => {
            return (data, reason) => {
                let sgroup = this.sense_hndls[sname];
                for(let mkey in sgroup) {
                    let [hndl, margs] = sgroup[mkey];
                    if(fmatch(data, ...margs)) {
                        if(hndl(data) !== true) {
                            delete sgroup[mkey];
                        }
                    }
                }
            }
        };
    }
    
    on_sense(sname, hndl, ...matchs) {
        let sgroup = this.sense_hndls[sname];
        if(!sgroup) {
            sgroup = {};
            this.sense_hndls[sname] = sgroup;
        }
        let mkey = matchs.join(',');
        if(sgroup[mkey]) {
            return false;
        }
        sgroup[mkey] = [hndl, matchs];
        return true;
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
    
    wait_frame(time = null) {
        if((time ?? null) === null) {
            time = 250;
        }
        return asleep(time);
    }
    
    async stdtask(mtd_name, task, ...args) {
        try {
            return await this[mtd_name](task, ...this.get_params(args));
        } catch (e) {
            if(e === ERR_PRSN_BREAK) {
                safe_log('Break: ' + mtd_name);
                return;
            } else if(e.message) {
                safe_log('Error:' + mtd_name + '(' + e.message + ')');
            } else if('reason' in e) {
                safe_log('Failed:' + mtd_name + '(' + e.reason + ')');
            }
        }
    }
    
    async looptask(mtd_name, task, ...args) {
        let control = {
            'need_wait': false,
            'done': false,
            'ftime': null,
            'context': {},
        };
        let cfg = new Set();;
        if(args[0]?.slice?.(0, 4) === 'cfg:') {
            let scfg = args.shift().slice(4);
            if(scfg.length > 0) {
                cfg = new Set(scfg.split(','));
            }
        }
        while(true) {
            if(control.done) {
                task.remove();
                safe_log('Done: ' + mtd_name);
                break;
            }
            try {
                if(control.need_wait || !cfg.has('nowait')) {
                    task.chk_break(await task.schedule(this.wait_frame(control.ftime)));
                    control.need_wait = false;
                }
                await this[mtd_name](task, control, ...this.get_params(args));
            } catch(e) {
                if(e === ERR_PRSN_BREAK) {
                    safe_log('Break: ' + mtd_name);
                    break;
                }
				if(e.message) {
                	safe_log('Error:' + mtd_name + '(' + e.message + ')');
				}
                if('reason' in e) {
                    safe_log('Failed:' + mtd_name + '(' + e.reason + ')');
                    control.need_wait = true;
                } else {
                    task.chk_break(await task.schedule(asleep(0)));
                }
            }
        }
    }
	
	break(tname = null, dostop = true) {
        if(tname) {
            let task = this.tasks[tname];
            if(task) {
                task.force_break = true;
                task.break();
            }
        } else {
            for(let tkey in this.tasks) {
                let task = this.tasks[tkey]; 
                task.force_break = true;
            }
            this.scheduler.break_all();
        }
        if(dostop) {
			stop();
		}
	}
	
}

class c_farmer_std extends c_persona {
    
    constructor() {
        super();
        this.tick = 0;
        this.reset_status();
        this.setup_consts();
        this.setup_sense();
    }
    
    reset_status() {
        this.stucked = false;
        this.battle = false;
        this.travel = false;
        this.runaway = false;
    }
    
    setup_consts() {
        this.C = {};
        this.C.MP_BLINK = 1600;
    }
    
    start_cave() {
        super.start([
            ['rest', 1],
            //['ping', 2],
            ['minds', 3, ['bat1', 'bat2', 'bat3'], 20],
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
			['go_farm', 100, 'cfg:nowait',
                this.params.param('tar_pos', [-50, -380]),
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
    
    start_jail() {
		super.start([
            ['rest', 1],
            ['ping', 2],
			['loot', 5],
            ['supply', 8],
			['target_monster', 10, this.params.param('tar_name', 'jrat')],
			['attack', 20, 'cfg:nowait'],
            ['move_back', 30, 'cfg:nowait', this.params.param('back_thr', 200)],
			['move_back_smart', 40, 'cfg:nowait',
                this.params.param('back_path', [[-180, -100], [-180, 100], [180, 100], [180, -100]]),
                this.params.param('back_thr')],
			['move_to_target', 50, 'cfg:nowait'],
		]);
	}
    
    start_forest() {
        super.start([
            ['rest', 1, 'forest'],
            //['ping', 2],
            //['minds', 3, ['bat1', 'bat2', 'bat3'], 60],
            ['loot', 5],
            ['supply', 8],
            ['shopping', 9, 'cfg:nowait'],
			//['target_monster', 10, this.params.param('tar_name', ['snake', 'osnake'])],
			['target_monster', 10, this.params.param('tar_name', [/*'scorpion',*/ 'xscorpion'])],
            ['calmdown', 12, pos => this.in_range([-900, 400, -260, 900], pos)],
            ['escape_blink_careful', 15, this.params.param('safe_point', [0, 0]), 2000],
            //['attack', 20, 'cfg:nowait'],
            //['attack', 20, 'cfg:nowait', this.calmdown = true],
            ['attack', 20, 'cfg:nowait', false, this.params.param('safe_thr', 150)],
            ['move_back', 30, 'cfg:nowait', this.params.param('back_thr', 200), 10,
                (spos, dpos) => !this.cross_range([-900, 400, -260, 900], spos, dpos)],
			//['move_back_smart', 40, 'cfg:nowait',
            //    this.params.param('back_path', [[530, -620], [430, -760], [160, -770], [290, -550]]),
            //    this.params.param('back_thr')],
            ['move_back_smart', 40, 'cfg:nowait',
                this.params.param('back_path', [
                    [-410, 840], [-675, 830], /*[-750, 630],*/ [-670, 510], [-410, 530], /*[-290, 730],*/
                ]),
                this.params.param('back_thr')],
            ['move_to_target', 50, 'cfg:nowait'],
			//['go_farm', 100, 'cfg:nowait',
            //    this.params.param('tar_pos', [380, -700]),
            //    this.params.param('tar_doors', ['Mainland:halloween'])],
            ['go_farm', 100, 'cfg:nowait',
                this.params.param('tar_pos', [-600, 490]),
                this.params.param('tar_doors', ['Mainland:halloween'])],
        ]);
    }
    
    start_snow() {
		super.start([
            ['rest', 1, 'snow'],
			['loot', 5],
            ['supply', 8],
            ['shopping', 9, 'cfg:nowait'],
			['target_monster', 10, this.params.param('tar_name', 'boar')],
            ['escape', 15, this.params.param('safe_point', [0, 0])],
			['attack', 20, 'cfg:nowait', false, this.params.param('safe_thr', 120)],
            ['move_back', 30, 'cfg:nowait', this.params.param('back_thr', 200), 10,
                (spos, dpos) => !this.cross_range([-300, -1630, 380, -595], spos, dpos)],
			['move_back_smart', 40, 'cfg:nowait',
                this.params.param('back_path', [[-160, -1520], [155, -1520], [240, -740], [-225, -755]]),
                this.params.param('back_thr')],
			['move_to_target', 50, 'cfg:nowait'],
            ['go_farm', 100, 'cfg:nowait',
                this.params.param('tar_pos', [-110, -850]),
                this.params.param('tar_doors', ['Mainland:winterland'])],
		]);
	}
	
	start_attack() {
		super.start([
            ['rest', 1],
			['loot', 5],
            ['supply', 8],
			['attack', 20, 'cfg:nowait'],
		]);
	}
    
    start_test() {
        super.start([
            ['rest', 1, 'test'],
			['loot', 5],
            ['supply', 8, 'idle'],
            ['shopping', 9, 'cfg:nowait'],
            ['escape', 15],
            //['attack', 20, 'cfg:nowait', false, this.params.param('safe_thr', 120)],
            //['move_back', 30, 'cfg:nowait', this.params.param('back_thr', 200)],
            //['move_back_smart', 40, 'cfg:nowait', [0, 0]],
		]);
    }
    
    start_idle() {
        super.start([
            ['rest', 1],
			['loot', 5],
            ['supply', 8, 'idle'],
            //['escape', 15],
		]);
    }
    
    start_revive(will = null) {
        super.start([
            ['revive', 10, will],
        ]);
    }
    
    start_upgrade(thrlvl = 5) {
        super.start([
            ['upgrade_all', 100, thrlvl],
        ]);
    }
    
    start_compound(thrlvl = 1) {
        super.start([
            ['compound_all', 100, thrlvl],
        ]);
    }
    
    setup_sense() {
        let gen_hndl = super.setup_sense();
        game.on('death', gen_hndl('death', (data, mid) => data.id === mid));
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
        const step_val = (ov, nv, dist) => ov + (nv - ov) / dist;
        let dist = this.dist_to(tar);
        return [
            step_val(character.x, tar.x, dist / step),
            step_val(character.y, tar.y, dist / step)]
    }
    
    in_range(rng, pos) {
        return pos[0] >= rng[0]
            && pos[0] < rng[2]
            && pos[1] >= rng[1]
            && pos[1] < rng[3];
    }
    
    cross_range(rng, spos, dpos, chkin = false, chkout = true) {
        let s_in = this.in_range(rng, spos);
        let d_in = this.in_range(rng, dpos);
        if(s_in === d_in) {
            return false;
        } else if(s_in && chkout) {
            return true;
        } else if(d_in && chkin) {
            return true;
        } else {
            return false;
        }
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
    
    calc_mp(omp) {
        return omp * (100 - character.mp_reduction) / 100
    }
    
    get tflg() {
        let flg = (this._tflg ?? null);
        this._tflg = null;
        return flg;
    }
    
    set tflg(v) {
        this._tflg = v;
        return true;
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
    
    async ablink(pos) {
        let omp = character.mp;
        let blink_mp = this.calc_mp(this.C.MP_BLINK);
        if(omp < blink_mp) {
            return false;
        }
        use_skill('blink', pos);
        //while(omp - character.mp < blink_mp * 0.6 /* thr for mp pot or other skill */) {
        while(
            Math.abs/* orb skill may restore mp */(omp - character.mp) < blink_mp * 0.6 /* thr for mp pot or other skill */
            && !(character.mp > omp && character.max_mp - omp <= blink_mp * 0.6) /* omp almost full and orb restored mp */) {
            if(character.mp < blink_mp) {
                return false;
            }
            await this.wait_frame();
        };
        for(let i = 0; i < 5 /* wait frames for check pos */; i++) {
            if(this.dist_to(pos) < 50) {
                return true;
            }
            await this.wait_frame();
        }
        return false;
    }
    
    async taskw_rest(task, ctrl, will = null) {
        if(character.rip) {
            safe_log('Down at ' + new Date().toLocaleString());
            this.break();
            this.on_idle(() => {
                this.reset_status();
                this.start_revive?.(will);
            });
        }
    }
    
    async taskw_revive(task, ctrl, will = null) {
        if(character.rip) {
            respawn();
        } else {
            safe_log('Revive at ' + new Date().toLocaleString());
            this.break();
            if(will) {
                this.on_idle(() => {
                    let sname = 'start_' + will;
                    safe_log('Start ' + will);
                    this[sname]?.();
                });
            }
        }
    }
    
    async taskw_ping(task, ctrl) {
        ctrl.ftime = 5000;
        safe_log('ping: ' + Math.floor(character.ping) + 'ms', 'grey');
    }
    
    async taskw_minds(task, ctrl, mindlist, dminutes = 60) {
        let midx = Math.floor((this.tick ++) / (dminutes * 60 * 4)) % mindlist.length;
        this.mind(mindlist[midx]);
    }
    
    async taskw_loot(task, ctrl) {
        loot();
    }
    
    async taskw_supply(task, ctrl, typ = 'std') {
        let tname = 'taskw_supply_' + typ;
        return this[tname]?.(task, ctrl);
    }
    
    async taskw_supply_std(task, ctrl) {
        if(is_on_cooldown("use_hp")) return;
        let hpv = character.hp/character.max_hp,
            hpd = character.max_hp - character.hp,
            mpv = character.mp/character.max_mp,
            mpd = character.max_mp - character.mp;
        if(hpv < 0.2) use_skill('use_hp');
        else if(mpv < 0.2) use_skill('use_mp');
        else if(character.mp < this.calc_mp(this.C.MP_BLINK) && this.needblink) use_skill('use_mp');
        else if(hpv < 0.8) use_skill('use_hp');
        else if(mpv < 0.7) use_skill('use_mp');
        else if(character.mp < this.C.MP_BLINK + 200) use_skill('use_mp'); // for blink
        else if(hpd > 50) use_skill('regen_hp');
        else if(mpd > 100) use_skill('regen_mp');
        else return;
        task.chk_break(await task.schedule(asleep(500)));
    }
    
    async taskw_supply_idle(task, ctrl) {
        if(is_on_cooldown("use_hp")) return;
        let hpv = character.hp/character.max_hp,
            hpd = character.max_hp - character.hp,
            mpv = character.mp/character.max_mp,
            mpd = character.max_mp - character.mp;
        if(character.mp < this.C.MP_BLINK + 200) use_skill('regen_mp'); // for blink
        else if(hpd > 50) use_skill('regen_hp');
        else if(mpd > 100) use_skill('regen_mp');
        else return;
        task.chk_break(await task.schedule(asleep(500)));
    }
    
    async taskw_shopping(task, ctrl, safe_point = [0, 0]) {
        let hpname = 'hpot1';
        let mpname = 'mpot0';
        if(quantity(hpname) > 50 && quantity(mpname) > 50) {
            ctrl.need_wait = true;
            return;
        }
        set_message("Go shopping");
        stop();
        task.hold();
        task.chk_break(await task.schedule(this.ablink(safe_point)));
        task.hold();
        task.chk_break(await task.schedule(this.amoveto('town')));
        set_message("shopping");
        let v_nd = 500;
        let hp_nd = v_nd - quantity(hpname);
        let mp_nd = v_nd - quantity(mpname);
        if(hp_nd > 0) {
            buy(hpname, hp_nd);
        }
        if(mp_nd > 0) {
            buy(mpname, mp_nd);
        }
		task.chk_break(await task.schedule(asleep(1000)));
    }
    
    async taskw_upgrade_all(task, ctrl, max_lvl = 5) {
        let thrlvl = ctrl.context.thrlvl;
        if(!(thrlvl >= 0)) {
            thrlvl = 0;
            ctrl.context.thrlvl = thrlvl;
        }
        if(ctrl.context.thrlvl ++ > max_lvl) {
            ctrl.done = true;
            return;
        }
        
        for(let i = 0; i < character.items.length; i++) {
            let item = character.items[i];
            if(!item) {
                continue;
            }
            let item_def = G.items[item.name];
            if(!item_def.upgrade || !('level' in item) || item.level > thrlvl) continue;
            if(quantity(item.name) < 2) continue;
            
            let scname;
            if(item_grade(item) === 0) {
                scname = thrlvl > 4 ? 'scroll1' : 'scroll0';
            } else if(item_grade(item) === 1) {
                scname = 'scroll1';
            } else {
                continue;
            }
            
            let sc_slot = locate_item(scname);
            if(sc_slot < 0) {
                try {
                    let data = task.chk_break(await task.schedule(buy(scname, 1)));
                    sc_slot = data.num;
                } catch(e) {
                    safe_log('buy failed: ' + e.reason);
                    ctrl.done = true;
                    return;
                }
            }
            try {
                let data = task.chk_break(await task.schedule(upgrade(i, sc_slot)));
                if(!data.success) {
                    safe_log('upgrade broken: ' + item.name + ':' + item.level);
                }
            } catch(e) {
                safe_log('upgrade failed: ' + e.reason);
                ctrl.done = true;
                return;
            }
        }
        return;
    }
    
    async taskw_compound_all(task, ctrl, thrlvl = 1) {
        let scname = thrlvl > 1 ? 'cscroll1' : 'cscroll0';
        if(character.q.compound) {
            return;
        }
        let com_list = {};
        let has_slot = false;
        let has_scroll = false;
        for(let i = 0; i < character.items.length; i++) {
            let item = character.items[i];
            if(!item) {
                has_slot = true;
                continue;
            } else if(item.name === scname) {
                has_scroll = true;
                continue;
            }
            let item_def = G.items[item.name];
            if(!item_def.compound || !('level' in item) || item.level > thrlvl) continue;
            let ckey = item.name + ':' + item.level;
            if(!com_list[ckey]) {
                com_list[ckey] = [[]];
            }
            let cgroup = com_list[ckey].slice(-1)[0];
            if(cgroup?.length === 3) {
                cgroup = [];
                com_list[ckey].push(cgroup);
            }
            cgroup.push(i);
        }
        if(!has_scroll && !has_slot) {
            ctrl.done = true;
            return;
        }
        let compounded = false;
        for(let ckey in com_list) {
            for(let cgroup of com_list[ckey]) {
                if(cgroup.length !== 3) {
                    continue;
                }
                let sc_slot = locate_item(scname);
                if(sc_slot < 0) {
                    try {
                        let data = task.chk_break(await task.schedule(buy(scname, 1)));
                        sc_slot = data.num;
                    } catch(e) {
                        safe_log('buy failed: ' + e.reason);
                        ctrl.done = true;
                        return;
                    }
                }
                try {
                    let data = task.chk_break(await task.schedule(compound(...cgroup, sc_slot)));
                    if(!data.success) {
                        safe_log('compound broken: ' + ckey);
                    }
                } catch(e) {
                    safe_log('compound failed: ' + e.reason);
                    ctrl.done = true;
                    return;
                }
                compounded = true;
            }
        }
        if(!compounded) {
            ctrl.done = true;
        }
        return;
    }
    
    taskw_escape(...args) {
        return this.taskw_escape_blink(...args);
    }
    
    async taskw_escape_blink(task, ctrl, safe_point = [0, 0]) {
        if(!character.fear) {
            this.needblink = false;
            return;
        }
        this.needblink = true;
        if(task.chk_break(await task.schedule(this.ablink(safe_point)))) {
            safe_log('escape by blink');
        } else {
            safe_log('blink failed');
        }
    }
    
    async taskw_escape_blink_careful(task, ctrl, safe_point = [0, 0], thr_hp = 2000) {
        if(!character.fear && character.hp > thr_hp) {
            this.needblink = false;
            return;
        }
        this.needblink = true;
        if(task.chk_break(await task.schedule(this.ablink(safe_point)))) {
            safe_log('escape by blink');
        } else {
            safe_log('blink failed');
        }
    }
    
    async taskw_escape_town(task, ctrl) {
        if(!character.fear) {
            return;
        }
        this.calmdown = true;
        set_message("escape");
        safe_log('use_town');
        use_skill('use_town');
        safe_log('wait 5s');
        task.chk_break(await task.schedule(asleep(5000)));
        safe_log('wait 5s done');
        if(character.fear/*get_nearest_monster({target: character.name})*/) {
            set_message("escape!!");
            safe_log('run to town');
            task.chk_break(await task.schedule(this.amoveto('town')));
        }
        this.calmdown = false;
    }
    
    async taskw_calmdown(task, ctrl, cb_battlerange = null) {
        if(cb_battlerange instanceof Function) {
            if(cb_battlerange([character.x, character.y])) {
               return; 
            }
        }
        if(character.targets === 0) {
            this.calmdown = true;
        } else {
            this.calmdown = false;
        }
    }
    
    async taskw_target_monster(task, ctrl, tname) {
        let target = get_targeted_monster();
        let dgr_target = get_nearest_monster({target: character.name});
        //let target_me = (get_target_of(target) === character);
        if(target && target === dgr_target) {
            return;
        } else if(dgr_target) {
            set_message("Targeted");
            change_target(dgr_target);
            return;
        }
        let tnames = tname;
        if(!(tname instanceof Array)) {
            tnames = [tnames];
        }
        if(tnames.includes(target?.mtype)) {
            return;
        }
        for(let i = tnames.length - 1; i >= 0; i--) {
            target = get_nearest_monster({type: tnames[i]});
            if(target) break;
        }
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
                this.calmdown = false;
                //safe_log('trav done');
            })
        ));
    }
    
    async taskw_move_to_target(task, ctrl, step = 10) {
        if(this.calmdown) {
            ctrl.need_wait = true;
            return;
        }
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
    
    async taskw_move_back(task, ctrl, thr = 120, step = 10, cb_validmove = null) {
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
        let vmv = true;
        if(cb_validmove instanceof Function) {
            vmv = cb_validmove([character.x, character.y], [nx, ny]);
        }
        if(!vmv || !can_move_to(nx, ny)) {
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
    
    async taskw_attack(task, ctrl, careful = false, safethr = null) {
        if(this.calmdown || this.needblink) {
            ctrl.need_wait = true;
            return;
        }
        let target = get_targeted_monster();
        if(!target || !can_attack(target)) {
            this.battle = false;
            ctrl.need_wait = true;
            return;
        }
        if(safethr && get_target_of(target) !== character) {
            let dist = this.dist_to(target);
            if(dist < safethr) {
                ctrl.need_wait = true;
                return;
            }
        }
        set_message("Attacking");
        this.battle = true;
        if(this.travel) {
            //safe_log('trav stop');
            stop();
        }
        task.chk_break(await task.schedule(attack(target).then(() => {
            this.on_sense('death', () => {
                this.battle = false;
                if(careful) {
                    this.calmdown = true;
                    set_message("Calmdown");
                }
            }, target.id);
        })));
    }
    
}

class c_show_view {
    
    constructor(val) {
        this.val = val;
        return new Proxy(this, {
            get(tar, prop, recv) {
                if(Reflect.has(tar, prop)) {
                    return Reflect.get(tar, prop, recv);
                } else if(tar?.val && Reflect.has(tar.val, prop)) {
                    let val = tar.val[prop];
                    return new c_show_view(val);
                } else {
                    return undefined;
                }
            }
        });
    }
    
    get show() {
        let val = this.val
        show_json(val);
        return val;
    }
    
}

class c_show_util {
    
    constructor() {
        this.colors = {
            info: 'pink',
        }
    }
    
    log(s, typ = 'info') {
        safe_log(s, this.colors[typ]);
    }
    
    view(val) {
        return new c_show_view(val);
    }
    
    v(...args) {
        return this.view(...args);
    }
    
    get pos() {
        let pos = [Math.floor(character.x), Math.floor(character.y)];
        this.log('pos: ' + pos.join(', '));
        return this.view(pos);
    }
    
    get map() {
        let map = get_map();
        this.log('map: ' + map.name);
        return this.view(map);
    }
    
    get doors() {
        let doors = this.map?.doors?.val?.map?.(v => v[4]);
        this.log('doors: ' + (doors?.length ?? 'none'));
        return this.view(doors);
    }
    
    cskills(cname = null) {
        let skeys = Object.keys(G.skills);
        let title = 'skills';
        if(cname) {
            skeys = skeys.filter(k => G.skills?.[k]?.class?.includes?.(cname));
            title += ' for ' + cname;
        }
        let skills = skeys.map(k => [k, G.skills[k].explanation]);
        this.log(title + ': ' + (skills?.length ?? 'none'));
        return this.view(skills);
    }
    
}

su = new c_show_util();

ch1 = new c_farmer_std();
//ch1.start_cave();
//ch1.start_forest();
//ch1.start_jail();
//ch1.start_compound();
//ch1.start_attack();
ch1.start_snow();
//ch1.start_test();
//ch1.start_idle();
//ch1.start_upgrade();
