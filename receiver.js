const amqp = require('amqplib/callback_api');

amqp.connect('amqp://localhost', (err, conn) => {
    conn.createChannel((err1, channel) => {
        channel.assertQueue('publish_requests', {
            durable: false
        });
        channel.consume('publish_requests', (msg) => {
            console.log('dikdidi');
            console.log(msg);
//            channel.ack(msg);
        }, {
            noAck: false
        });
    });
});
