import * as sdk from '@larksuiteoapi/node-sdk';
import { makeRegistrationPost } from '../src/registration-transport.js';
import { enrollExistingApp } from '../src/enrollment.js';
import { createEnrollmentFileReporter } from '../src/enrollment-report-files.js';
const [appId,tenant,credentialsFile,directory,scanApproval,storageApproval]=process.argv.slice(2);
if(process.argv.length!==8||tenant!=='--tenant-pending'||scanApproval!=='--confirm-existing-app-scan'||storageApproval!=='--confirm-private-storage'){
 process.stderr.write('File-handoff enrollment requires the exact approved existing app and private paths.\n');process.exit(1);
}
const controller=new AbortController();let reporter,timer;
try{
 reporter=createEnrollmentFileReporter({directory,appId,onFailure:()=>controller.abort()});
 if(reporter.status().report_failed)throw Error();
 process.once('exit',code=>reporter.closed(code));
 const abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);process.once('SIGHUP',abort);
 timer=setInterval(()=>{reporter.heartbeat();if(reporter.shouldStop())controller.abort();},2000);timer.unref();
 sdk.defaultHttpInstance.post=makeRegistrationPost({report:reporter.report});
 const result=await enrollExistingApp({appId,allowUnbound:true,credentialsFile,approvedScan:true,approvedStorage:true,sdk,report:reporter.report,signal:controller.signal});
 const success=result.enrollment_completed===true;reporter.finish(success);if(!success)process.exitCode=1;
}catch{process.exitCode=1;reporter?.report({failure_code:'enrollment_runner_failed'});reporter?.finish(false);process.stderr.write('Enrollment stopped; inspect fixed private status only. No secret values printed.\n');}
finally{clearInterval(timer);}
