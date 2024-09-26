"use strict";

const child_process = require("child_process");
const fs = require("fs-extra");
const { SubtitleTime } = require('subtitle-time')
const {google} = require('googleapis');
const readline = require('readline');
const path = require("path");
const express = require("express");
const { ArgumentParser } = require('argparse');
const moment = require('moment');
const os = require('os');
const jimp = require('jimp');
const crypto = require('crypto');
const file = require("fs-extra/lib/ensure/file");

const OAuth2 = google.auth.OAuth2;

const mediainfo = {};

const parser = new ArgumentParser({
    description: 'Concat vids and upload shiz'
});
parser.add_argument('dirs', {type: String, nargs:'*',help:'Dir of videos'})
parser.add_argument('--timestamps', { choices:['hard','soft'], required:false });
parser.add_argument('--adjust_timestamp_date', { type: String, help: "format: 'dd/mm/yyyy' or '+1 year -1 month'" });
parser.add_argument('-u', '--upload', { action:'store_true' });
parser.add_argument('-s', '--scale', { type:String, default:"" });
parser.add_argument('-v', '--vcodec', { type:String, default:"copy" });
parser.add_argument('-vo', '--vcodec_opts', { type:String, help:`Example: profile:v=main,rc:v=constqp,qp=22` });
parser.add_argument('-vp', '--vcodec_preset', { type:String });
parser.add_argument('-a', '--acodec', { type:String, default:"aac" });
parser.add_argument('-ap', '--acodec_preset', { type:String });
parser.add_argument('-ao', '--acodec_opts', { type:String, default:`b:a=160k` });
parser.add_argument('-o', '--output_dir', { type: String });
parser.add_argument('-t', '--test', { action:'store_true' });
parser.add_argument('--keep_tmp', { action:'store_true' });

const args = parser.parse_args();

if (args.output_dir) args.output_dir = path.resolve(args.output_dir);
args.dirs = args.dirs.map(p=>path.resolve(p));

/* const tmp = path.join(args.output_dir || os.tmpdir(), `concat-vids-tmp-${crypto.randomBytes(8).toString('hex')}`);
fs.mkdirSync(tmp, {recursive:true});
fs.emptyDirSync(tmp);
 */
const ass_template = `[Script Info]
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: 384
PlayResY: 288

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: style1,Arial,12,&H0000FF,&H0000FF,&H000000,&H000000,0,0,0,0,100,100,0,0,0,0.5,0,1,2,2,2,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

function av_escape(str) {
    return str.replace(/\\/g, "\\\\\\\\").replace(/'/g, `'\\\\''`).replace(/:/g, "\\:")
}

function question(str) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    let prom = new Promise(resolve=>{
        rl.question(str, (ans)=>{
            rl.close();
            resolve(!!ans.match(/y/i));
        });
    });
    prom.cancel = ()=>{
        rl.write("");
        rl.close();
        // process.stdout.write("\r\n");
    }
    return prom;
}

async function ffprobe(f) {
    if (!mediainfo[f]) {
        console.log(`Getting mediainfo for '${f}'...`);
        await new Promise(resolve=>{
            child_process.exec(`ffprobe -show_format -show_streams -print_format json -loglevel quiet -show_chapters "${f}"`, (err, stdout, stderr)=>{
                mediainfo[f] = JSON.parse(stdout.toString());
                resolve();
            })
        })
    }
    return mediainfo[f];
}

async function authorize() {
    const token_path = path.resolve(__dirname, "client_oauth_token.json");
    const credentials = JSON.parse(fs.readFileSync(path.resolve(__dirname, "client_secret.json"), "utf-8"));
    const scopes = ['https://www.googleapis.com/auth/youtube.upload'];
    var token;
    const oauth2 = new OAuth2(credentials.installed.client_id, credentials.installed.client_secret, "http://localhost:8228");
    try { token = JSON.parse(fs.readFileSync(token_path, "utf-8")); } catch {}
    
    if (!token) {
        token = await new Promise(async resolve=>{
            const authUrl = oauth2.generateAuthUrl({
                access_type: 'offline',
                scope: scopes
            });
            console.log('Authorize this app by visiting this url: ', authUrl);
            const app = express();
            var server = app.listen(8228);
            app.get("/", async (req,res)=>{
                res.status(200).send("Success! Close this window");
                server.close();
                var code = req.query.code;
                var a = await oauth2.getToken(code);
                fs.writeFileSync(token_path, JSON.stringify(a.tokens));
                resolve(a.tokens);
            })
        });
    }
    oauth2.setCredentials(token);
    return oauth2;
}

async function upload(file, info) {
    let size = fs.statSync(file).size;
    let t = +new Date();
    let oauth2 = await authorize();
    const service = google.youtube('v3');
    let res = await service.videos.insert({
        auth: oauth2,
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title: info.title || path.basename(file),
                description: info.description,
                // tags,
                defaultLanguage: 'en',
                defaultAudioLanguage: 'en'
            },
            status: {
                privacyStatus: "public",
                selfDeclaredMadeForKids: false,
            },
        },
        media: {
            body: fs.createReadStream(file),
        },
    }, {
        onUploadProgress: (e=>{
            let now = +new Date();
            if (now >= t+1000) {
                console.log(((e.bytesRead/size)*100).toFixed(2)+"%");
                t = now;
            }
        })
    }).catch((err)=>{
        console.log('The API returned an error: ' + err);
    });

    if (res) {
        console.log(res.data);

        if (info.thumbnail) {
            console.log('Video uploaded. Uploading the thumbnail now.')
            res = await service.thumbnails.set({
                auth: oauth2,
                videoId: res.data.id,
                media: {
                    body: fs.createReadStream(info.thumbnail)
                },
            });
            console.log(res.data)
        }
    }
}

async function concat(files, output_path) {
    fs.mkdirSync(path.dirname(output_path), {recursive:true});

    let ffmpeg_args = []
    let ffmpeg_vf = [];
    let ffmpeg_af = ["dynaudnorm=f=500:p=0.9:m=8.0:g=7"];
    let mkvmerge_args = [];
    let description = [];
    let meta = [`;FFMETADATA1`];
    let ass = [ass_template];

    let concat_list = [];

    let t = 0, i = 0;
    let first_end;
    for (let f of files) {
        let duration = +parseFloat((await ffprobe(f)).format.duration).toFixed(2);
        let stat = fs.statSync(f);
        let end = +stat.mtime;
        if (!first_end) first_end = end;
        var segments = [], m;

        if (m = f.match(/\[([\d\,\-\.\s]+)\]/)) {
            let segs = m[1].split(",");
            for (let s of segs) {
                let [start,end] = s.split("-");
                start = +start || 0;
                end = +end || duration;
                segments.push([start,end]);
            }
        } else {
            segments.push([0,duration])
        }
        if (args.adjust_timestamp_date) {
            let m;
            for (m of args.adjust_timestamp_date.matchAll(/(\+|\-)\s*(\d+)\s*([a-z]+)/gi)) {
                let amount = +m[2];
                if (m[1] == "-") amount *= -1;
                let unit = m[3];
                end = +moment(end).add(amount, unit).toDate()
            }
            if (!m) {
                end += moment(args.adjust_timestamp_date).toDate() - first_end;
            }
        }

        let start_date = end - (duration*1000);
        for (let segment of segments) {
            
            let [segment_start, segment_end] = segment;
            let segment_duration = segment_end-segment_start;
            let segment_start_date = start_date + (segment_start * 1000);

            concat_list.push(`file '${path.resolve(f)}'`);
            if (segment_start != 0) concat_list.push(`inpoint ${new SubtitleTime(segment_start, 'second').to("vtt")}`);
            if (segment_end != duration) concat_list.push(`outpoint ${new SubtitleTime(segment_end, 'second').to("vtt")}`);
            
            let t_formatted = new SubtitleTime(Math.round(t), 'second').to("ass").split(".")[0];
            if (t < 3600) t_formatted = t_formatted.split(":").slice(1).join(":");
            let s = String(i+1).padStart(2, "0");
            meta.push(`[CHAPTER]`, `TIMEBASE=1/1000`, `START=${t*1000}`, `END=${(t+segment_duration)*1000}`, `title=Segment ${s} [${moment(segment_start_date).format("hh:mm:ss A")}]`,"");
            description.push(`${t_formatted} - Segment ${s} [${moment(segment_start_date).format("h꞉mm꞉ss A")}]`); // time of day uses special colon character separator
            
            if (args.timestamps) {
                let t2 = 0;
                while (t2 < segment_duration) {
                    let from = new SubtitleTime(t+t2, 'second').to("ass");
                    let to = new SubtitleTime(Math.min(t+t2+1, segment_duration), 'second').to("ass");
                    let date_str = moment(new Date(segment_start_date + (t2*1000))).format("DD/MM/YYYY hh:mm:ss A");
                    ass.push(`Dialogue: 0,${from},${to},style1,,0,0,0,,${date_str}`);
                    t2++;
                }
            }
            i++;
            t += segment_duration;
        }
    }

    console.log(`Total Duration: ${new SubtitleTime(t, 'second').to("vtt")}`);
    
    let concat_txt_path = path.join("tmp", "concat.txt");
    fs.writeFileSync(concat_txt_path, concat_list.join("\n"), "utf8");
    ffmpeg_args.push("-f", "concat", "-safe", "0", "-i", concat_txt_path);

    if (args.timestamps) {
        let times_path = path.join("tmp", "times.ass");
        fs.writeFileSync(times_path, ass.join("\n"), "utf8");
        // mkvmerge_args.push("tmp/times.ass");
        if (args.timestamps=="hard") {
            ffmpeg_vf.push(`subtitles=\\'${av_escape(times_path.replace(/\\/g,"/"))}\\'`);
        } else {
            ffmpeg_args.push("-i", times_path);
        }
    }

    let meta_path = path.join("tmp", "meta.txt");
    meta = meta.join("\n");
    fs.writeFileSync(meta_path, meta, "utf8");
    ffmpeg_args.push("-i", meta_path, "-map_metadata", "1");
    
    if (args.scale) {
        ffmpeg_vf.push(`scale=${args.scale}`)
    }

    // mkvmerge_args.push("[", ...files, "]");

    if (ffmpeg_vf.length) {
        ffmpeg_args.push("-vf", ffmpeg_vf.join(","));
    }
    if (ffmpeg_af.length) {
        ffmpeg_args.push("-af", ffmpeg_af.join(","));
    }

    // ffmpeg_args.push("-c", "copy");

    var parse_codec_opts = (str)=>{
        return String(str).split(/,\s*/).map(p=>{
            var i = p.indexOf("=");
            return [`-${p.slice(0,i)}`, `${p.slice(i+1)}`]
        }).flat()
    }
    if (args.vcodec) {
        // ffmpeg_args.push("-c:v", "libx264", "-preset", "slow", "-crf", "20");
        // ffmpeg_args.push("-c:v", "h264_nvenc", "-profile:v", "high", "-rc:v", "constqp", "-qp", "18");
        ffmpeg_args.push("-c:v", args.vcodec);
        if (args.vcodec_preset) ffmpeg_args.push("-preset:v", vcodec_preset);
        if (args.vcodec_opts) ffmpeg_args.push(...parse_codec_opts(args.vcodec_opts));
        // if (args.vcodec_preset == "low") ffmpeg_args.push("-preset:v", "fast", "-profile:v", "main", "-rc:v", "constqp", "-qp", "28");
        // else if (args.vcodec_preset == "med") ffmpeg_args.push("-preset:v", "medium", "-profile:v", "main", "-rc:v", "constqp", "-qp", "22");
        // else if (args.vcodec_preset == "high") ffmpeg_args.push("-preset:v", "default", "-profile:v", "main", "-rc:v", "constqp", "-qp", "18");
    }
    if (args.acodec) {
        ffmpeg_args.push("-c:a", args.acodec);
        if (args.acodec_preset) ffmpeg_args.push("-preset:a", acodec_preset);
        if (args.acodec_opts) ffmpeg_args.push(...parse_codec_opts(args.acodec_opts));
    }
    
    if (args.test) ffmpeg_args.push("-t", "60");

    ffmpeg_args.push("-f", "matroska", "-y", output_path);

    if (!fs.existsSync(output_path) || (await question(`'${output_path}' already exists. Overwrrite? [Y/N]`))) {
        
        console.log("ffmpeg "+ffmpeg_args.join(" "))

        await new Promise(async resolve=>{
            let cp = child_process.spawn("ffmpeg", ffmpeg_args, {
                detached:true,
                // stdio:['pipe', 'pipe', 'inherit'],
            });
            cp.stdout.pipe(process.stdout);
            cp.stderr.pipe(process.stdout);
            cp.on("exit", resolve);
        });
    }

    // mkvmerge_args = ["--generate-chapters", "when-appending", "-o", "output/concat.mkv", ...mkvmerge_args];

    return {
        description: description.join("\n")
    }
}

async function fix_thumbnail(thumbnail) {
    var out = path.join("tmp", path.basename(thumbnail, path.extname(thumbnail))+".jpg");
    var image = await jimp.read(thumbnail);
    await image.cover(1920, 1080).quality(80).write(out);
    return out;
}

async function run() {

    var dirs = args.dirs;
    if (!dirs.length) dirs[0] = ".";
    // var cwd = process.cwd();
    for (var d of dirs) {
        process.chdir(d);

        fs.mkdirSync("tmp", {recursive:true});
        fs.emptyDirSync("tmp");

        let files = fs.readdirSync(".").filter((f=>f.match(/\.(avi|mp4|mkv|qt)$/)));
        let name = path.basename(path.resolve("."));
        // let timestamp = [new Date().toLocaleDateString(), new Date().toLocaleTimeString()].join("-").replace(/[^\d]+/g, "-");
        let filename = name; // [name, crypto.randomBytes(8).toString('hex')].join(" ")
        if (args.test) filename += "-test";
        let output_path = path.join(args.output_dir || "output", `${filename}.mkv`);
        
        let res = await concat(files, output_path);

        let do_upload = args.upload || await question(`Upload '${output_path}' file to YouTube? [Y/N]`);

        let thumbnail = fs.readdirSync(".").find(f=>f.match(/\.(png|jpe?g|bmp|gif)$/));
        if (thumbnail) thumbnail = await fix_thumbnail(thumbnail);


        if (do_upload) {
            await upload(output_path, {
                title: name,
                thumbnail: thumbnail,
                description: res.description
            });
        }
        if (!args.keep_tmp) {
            fs.rmSync("tmp", {recursive:true, force:true})
        }
    }

    // process.chdir(cwd);
    process.exit();
}

run();